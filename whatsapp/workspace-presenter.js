import { renderFileChangeContent } from "./outbound/send-content.js";
import { markdownToWhatsApp } from "../message-renderer.js";
import { formatPlanPresentationText } from "../plan-presentation.js";
import { formatActivitySummary } from "../tool-presentation-model.js";
import { formatToolPresentationDisplay, formatToolPresentationSummary } from "../presentation/whatsapp.js";
import { contentEvent } from "../outbound-events.js";

const SOURCE_PREFIX = /** @type {Record<MessageSource, string>} */ ({
  llm: "🤖",
  "tool-call": "🔧",
  "tool-result": "✅",
  error: "❌",
  warning: "⚠️",
  usage: "📊",
  memory: "🧠",
  plain: "",
});

/**
 * @param {string} workspaceName
 * @param {string | undefined} sourceChatName
 * @returns {string}
 */
function buildWorkspaceSurfaceName(workspaceName, sourceChatName) {
  const trimmedChatName = sourceChatName?.trim();
  if (!trimmedChatName) {
    return workspaceName;
  }
  return `[${workspaceName}] ${trimmedChatName}`;
}

/**
 * @param {string} repoId
 * @param {string | undefined} sourceChatName
 * @returns {string}
 */
function buildCommunitySurfaceName(repoId, sourceChatName) {
  const trimmedChatName = sourceChatName?.trim();
  return trimmedChatName || `repo-${repoId}`;
}

/**
 * @param {string} workspaceName
 * @param {WhatsAppWorkspacePresentationRole} role
 * @returns {string}
 */
function buildCommunityWorkspaceSurfaceName(workspaceName, role) {
  if (role === "main") {
    return "main";
  }
  return workspaceName;
}

/**
 * @param {WhatsAppRepoPresentationRow | null} repoPresentation
 * @param {string} workspaceId
 * @returns {WhatsAppWorkspacePresentationRole}
 */
function resolveWorkspaceRole(repoPresentation, workspaceId) {
  if (repoPresentation?.topology_kind === "community" && repoPresentation.main_workspace_id === workspaceId) {
    return "main";
  }
  return "workspace";
}

/**
 * @param {string} workspaceId
 * @param {WhatsAppWorkspacePresentationRow[]} presentations
 * @returns {WhatsAppWorkspacePresentationRow | null}
 */
function findWorkspacePresentation(workspaceId, presentations) {
  return presentations.find((presentation) => presentation.workspace_id === workspaceId) ?? null;
}

/**
 * @param {ToolContentBlock} block
 * @returns {string}
 */
function stringifyContentBlock(block) {
  switch (block.type) {
    case "text":
      return block.text;
    case "markdown":
      return markdownToWhatsApp(block.text);
    case "code":
      return [block.caption, "```", block.code, "```"].filter(Boolean).join("\n");
    case "diff":
      return [block.caption, block.diffText ?? "Diff available."].filter(Boolean).join("\n\n");
    case "image":
      return block.alt ?? "[image]";
    case "video":
      return block.alt ?? "[video]";
    case "audio":
      return "[audio]";
    default:
      return "";
  }
}

/**
 * @param {SendContent} content
 * @returns {string}
 */
function stringifyContent(content) {
  if (typeof content === "string") {
    return content;
  }
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(stringifyContentBlock).filter(Boolean).join("\n\n");
}

/**
 * Best-effort textual fallback when a transport does not support semantic
 * workspace events directly.
 * @param {OutboundEvent} event
 * @returns {string}
 */
function stringifyEvent(event) {
  switch (event.kind) {
    case "content": {
      const text = stringifyContent(event.content);
      const prefix = SOURCE_PREFIX[event.source];
      return prefix && text ? `${prefix} ${text}` : text;
    }
    case "tool_call":
      return `${SOURCE_PREFIX["tool-call"]} ${formatToolPresentationDisplay(event.presentation) ?? formatToolPresentationSummary(event.presentation)}`.trim();
    case "tool_activity":
      return `${SOURCE_PREFIX["tool-call"]} ${formatActivitySummary(event.activity)}`.trim();
    case "plan":
      return `${SOURCE_PREFIX.llm} ${formatPlanPresentationText(event.presentation)}`.trim();
    case "file_change": {
      const rendered = renderFileChangeContent(event);
      return `${SOURCE_PREFIX["tool-call"]} ${stringifyContent(rendered)}`.trim();
    }
    case "usage":
      return `${SOURCE_PREFIX.usage} Cost: ${event.cost} | prompt=${event.tokens.prompt} cached=${event.tokens.cached} completion=${event.tokens.completion}`;
    default:
      return "";
  }
}

/**
 * WhatsApp-specific workspace presentation adapter.
 * It owns whether a workspace is rendered as a flat group or as a
 * community-linked subgroup.
 * @param {{
 *   transport: ChatTransport,
 *   store: Pick<Awaited<ReturnType<typeof import("../store.js").initStore>>,
 *     "getWhatsAppRepoPresentation"
 *     | "getWhatsAppWorkspacePresentation"
 *     | "listWhatsAppWorkspacePresentations"
 *     | "saveWhatsAppWorkspacePresentation"
 *     | "upsertWhatsAppRepoPresentation">,
 * }} input
 * @returns {WorkspacePresentationPort}
 */
export function createWhatsAppWorkspacePresenter({ transport, store }) {
  /**
   * Placeholder seam for future support of reusing an existing plain group as the
   * `main` subgroup inside a community. Current transport probing shows WhatsApp
   * rejects that link with a server-side 400, so migration creates a fresh
   * community-native `main` group instead.
   * @param {{
   *   existingWorkspacePresentation: WhatsAppWorkspacePresentationRow,
   *   communityChatId: string,
   * }} _input
   * @returns {Promise<
   *   | { kind: "adopted", surfaceId: string, surfaceName: string }
   *   | { kind: "unsupported", reason: string }
   * >}
   */
  async function adoptExistingWorkspaceSurfaceIntoCommunity(_input) {
    return {
      kind: "unsupported",
      reason: "Linking an existing group into a community is not implemented yet.",
    };
  }

  /**
   * @param {string} workspaceId
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function sendPlainWorkspaceContent(workspaceId, text) {
    await presenter.sendWorkspaceEvent({
      workspaceId,
      event: contentEvent("plain", [{ type: "text", text }]),
    });
  }

  /**
   * @param {string} workspaceId
   * @returns {Promise<WhatsAppWorkspacePresentationRow>}
   */
  async function getWorkspacePresentation(workspaceId) {
    const presentation = await store.getWhatsAppWorkspacePresentation(workspaceId);
    if (!presentation) {
      throw new Error(`WhatsApp presentation for workspace ${workspaceId} does not exist.`);
    }
    return presentation;
  }

  /**
   * @param {{
   *   repoId: string,
   *   workspaceId: string,
   *   workspaceName: string,
   *   sourceChatName?: string,
   *   requesterJids: string[],
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function provisionFlatWorkspaceSurface({
    repoId,
    workspaceId,
    workspaceName,
    sourceChatName,
    requesterJids,
  }) {
    if (!transport.createGroup) {
      throw new Error("Workspace creation requires workspace surface provisioning support.");
    }
    const surfaceName = buildWorkspaceSurfaceName(workspaceName, sourceChatName);
    const group = await transport.createGroup(surfaceName, requesterJids);
    if (transport.promoteParticipants && requesterJids.length > 0) {
      await transport.promoteParticipants(group.chatId, requesterJids);
    }
    const persistedSurfaceName = typeof group.subject === "string" ? group.subject : surfaceName;
    await store.upsertWhatsAppRepoPresentation({
      repoId,
      topologyKind: "groups",
      mainWorkspaceId: workspaceId,
    });
    await store.saveWhatsAppWorkspacePresentation({
      repoId,
      workspaceId,
      workspaceChatId: group.chatId,
      workspaceChatSubject: persistedSurfaceName,
    });
    return {
      surfaceId: group.chatId,
      surfaceName: persistedSurfaceName,
    };
  }

  /**
   * @param {{
   *   repoId: string,
   *   workspaceId: string,
   *   workspaceName: string,
   *   requesterJids: string[],
   *   communityChatId: string,
   *   role: WhatsAppWorkspacePresentationRole,
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function provisionCommunityWorkspaceSurface({
    repoId,
    workspaceId,
    workspaceName,
    requesterJids,
    communityChatId,
    role,
  }) {
    if (!transport.createCommunityGroup) {
      throw new Error("Workspace creation requires community subgroup provisioning support.");
    }
    const surfaceName = buildCommunityWorkspaceSurfaceName(workspaceName, role);
    const group = await transport.createCommunityGroup(surfaceName, requesterJids, communityChatId);
    const persistedSurfaceName = typeof group.subject === "string" ? group.subject : surfaceName;
    await store.saveWhatsAppWorkspacePresentation({
      repoId,
      workspaceId,
      workspaceChatId: group.chatId,
      workspaceChatSubject: persistedSurfaceName,
      role,
      linkedCommunityChatId: communityChatId,
    });
    return {
      surfaceId: group.chatId,
      surfaceName: persistedSurfaceName,
    };
  }

  /**
   * @param {{
   *   repoId: string,
   *   workspaceId: string,
   *   workspaceName: string,
   *   sourceChatName?: string,
   *   requesterJids: string[],
   *   repoPresentation: WhatsAppRepoPresentationRow | null,
   * }} input
   * @returns {Promise<{ surfaceId: string, surfaceName: string }>}
   */
  async function provisionWorkspaceSurface(input) {
    const existingPresentations = await store.listWhatsAppWorkspacePresentations(input.repoId);
    if (input.repoPresentation?.topology_kind === "community") {
      if (!input.repoPresentation.community_chat_id) {
        throw new Error(`Community presentation for repo ${input.repoId} is missing its community chat id.`);
      }
      return provisionCommunityWorkspaceSurface({
        repoId: input.repoId,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        requesterJids: input.requesterJids,
        communityChatId: input.repoPresentation.community_chat_id,
        role: resolveWorkspaceRole(input.repoPresentation, input.workspaceId),
      });
    }

    if (existingPresentations.length === 0) {
      return provisionFlatWorkspaceSurface(input);
    }

    if (!transport.createCommunity) {
      throw new Error("Workspace creation requires community provisioning support.");
    }
    const mainWorkspaceId = input.repoPresentation?.main_workspace_id ?? existingPresentations[0]?.workspace_id;
    if (!mainWorkspaceId) {
      throw new Error(`Could not determine the main workspace for repo ${input.repoId}.`);
    }
    const mainWorkspacePresentation = findWorkspacePresentation(mainWorkspaceId, existingPresentations);
    if (!mainWorkspacePresentation) {
      throw new Error(`Could not find the persisted workspace presentation for main workspace ${mainWorkspaceId}.`);
    }

    const community = await transport.createCommunity(buildCommunitySurfaceName(input.repoId, input.sourceChatName), "");
    const adoptedMainSurface = await adoptExistingWorkspaceSurfaceIntoCommunity({
      existingWorkspacePresentation: mainWorkspacePresentation,
      communityChatId: community.chatId,
    });
    if (adoptedMainSurface.kind === "adopted") {
      await store.saveWhatsAppWorkspacePresentation({
        repoId: input.repoId,
        workspaceId: mainWorkspaceId,
        workspaceChatId: adoptedMainSurface.surfaceId,
        workspaceChatSubject: adoptedMainSurface.surfaceName,
        role: "main",
        linkedCommunityChatId: community.chatId,
      });
    } else {
      await provisionCommunityWorkspaceSurface({
        repoId: input.repoId,
        workspaceId: mainWorkspaceId,
        workspaceName: "main",
        requesterJids: input.requesterJids,
        communityChatId: community.chatId,
        role: "main",
      });
    }
    await store.upsertWhatsAppRepoPresentation({
      repoId: input.repoId,
      topologyKind: "community",
      communityChatId: community.chatId,
      mainWorkspaceId,
    });
    return provisionCommunityWorkspaceSurface({
      repoId: input.repoId,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      requesterJids: input.requesterJids,
      communityChatId: community.chatId,
      role: "workspace",
    });
  }

  /** @type {WorkspacePresentationPort} */
  const presenter = {
    async ensureWorkspaceVisible({ repoId, workspaceId, workspaceName, sourceChatName, requesterJids }) {
      const repoPresentation = await store.getWhatsAppRepoPresentation(repoId);
      const existing = await store.getWhatsAppWorkspacePresentation(workspaceId);

      if (existing) {
        const role = existing.role ?? resolveWorkspaceRole(repoPresentation, workspaceId);
        const linkedCommunityChatId = repoPresentation?.topology_kind === "community"
          ? repoPresentation.community_chat_id
          : existing.linked_community_chat_id;
        const surfaceName = repoPresentation?.topology_kind === "community"
          ? buildCommunityWorkspaceSurfaceName(workspaceName, role)
          : buildWorkspaceSurfaceName(workspaceName, sourceChatName);
        if (transport.renameGroup) {
          await transport.renameGroup(existing.workspace_chat_id, surfaceName);
        }
        if (transport.setAnnouncementOnly) {
          await transport.setAnnouncementOnly(existing.workspace_chat_id, false);
        }
        if (transport.promoteParticipants && requesterJids.length > 0) {
          try {
            await transport.promoteParticipants(existing.workspace_chat_id, requesterJids);
          } catch {
            // Best effort: the requester may not already be in the existing group.
          }
        }
        await store.saveWhatsAppWorkspacePresentation({
          repoId,
          workspaceId,
          workspaceChatId: existing.workspace_chat_id,
          workspaceChatSubject: surfaceName,
          role,
          linkedCommunityChatId,
        });
        return {
          surfaceId: existing.workspace_chat_id,
          surfaceName,
        };
      }

      return provisionWorkspaceSurface({
        repoId,
        workspaceId,
        workspaceName,
        sourceChatName,
        requesterJids,
        repoPresentation,
      });
    },

    async presentWorkspaceBootstrap({ workspaceId, statusText }) {
      await sendPlainWorkspaceContent(workspaceId, statusText);
    },

    async presentSeedPrompt({ workspaceId, promptText }) {
      await sendPlainWorkspaceContent(workspaceId, promptText);
    },

    async getWorkspaceSurface({ workspaceId }) {
      const presentation = await getWorkspacePresentation(workspaceId);
      return {
        surfaceId: presentation.workspace_chat_id,
        surfaceName: presentation.workspace_chat_subject,
      };
    },

    async sendWorkspaceEvent({ workspaceId, event }) {
      const presentation = await getWorkspacePresentation(workspaceId);
      if (transport.sendEvent) {
        return transport.sendEvent(presentation.workspace_chat_id, event);
      }
      const text = stringifyEvent(event).trim();
      if (text) {
        await transport.sendText(presentation.workspace_chat_id, text);
      }
      return undefined;
    },

    async archiveWorkspaceSurface({ workspaceId }) {
      const presentation = await getWorkspacePresentation(workspaceId);
      if (transport.renameGroup) {
        await transport.renameGroup(
          presentation.workspace_chat_id,
          `${presentation.workspace_chat_subject} (archived)`,
        );
      }
      if (transport.setAnnouncementOnly) {
        await transport.setAnnouncementOnly(presentation.workspace_chat_id, true);
      }
    },
  };

  return presenter;
}
