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
 * It owns the fact that a workspace surface is represented as a group.
 * @param {{
 *   transport: ChatTransport,
 *   store: Pick<Awaited<ReturnType<typeof import("../store.js").initStore>>,
 *     "getWhatsAppRepoPresentation"
 *     | "getWhatsAppWorkspacePresentation"
 *     | "saveWhatsAppWorkspacePresentation"
 *     | "upsertWhatsAppRepoPresentation">,
 * }} input
 * @returns {WorkspacePresentationPort}
 */
export function createWhatsAppWorkspacePresenter({ transport, store }) {
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

  /** @type {WorkspacePresentationPort} */
  const presenter = {
    async ensureWorkspaceVisible({ repoId, workspaceId, workspaceName, sourceChatName, requesterJids }) {
      const surfaceName = buildWorkspaceSurfaceName(workspaceName, sourceChatName);
      const existing = await store.getWhatsAppWorkspacePresentation(workspaceId);

      if (existing) {
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
          role: existing.role,
          linkedCommunityChatId: existing.linked_community_chat_id,
        });
        return {
          surfaceId: existing.workspace_chat_id,
          surfaceName,
        };
      }

      if (!transport.createGroup) {
        throw new Error("Workspace creation requires workspace surface provisioning support.");
      }
      const group = await transport.createGroup(surfaceName, requesterJids);
      if (transport.promoteParticipants && requesterJids.length > 0) {
        await transport.promoteParticipants(group.chatId, requesterJids);
      }
      const persistedSurfaceName = typeof group.subject === "string" ? group.subject : surfaceName;
      const repoPresentation = await store.getWhatsAppRepoPresentation(repoId);
      if (!repoPresentation) {
        await store.upsertWhatsAppRepoPresentation({
          repoId,
          topologyKind: "groups",
        });
      }
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
    },

    async presentWorkspaceBootstrap({ workspaceId, statusText }) {
      await sendPlainWorkspaceContent(workspaceId, statusText);
    },

    async presentSeedPrompt({ workspaceId, promptText }) {
      await sendPlainWorkspaceContent(workspaceId, promptText);
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
