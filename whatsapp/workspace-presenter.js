import { renderFileChangeContent } from "./outbound/send-content.js";
import { markdownToWhatsApp } from "../message-renderer.js";
import { formatPlanPresentationText } from "../plan-presentation.js";
import { parseToolArgs } from "../agent-io-defaults.js";
import { buildToolPresentation } from "./tool-presentation-model.js";
import { renderToolActivityContent, renderToolPresentationContent } from "./tool-presenter.js";
import { createAppOutputPort } from "../app-output-port.js";
import { formatUsageEventText } from "../usage-formatting.js";
import { appMessageRoleToSource } from "./outbound/event-rendering.js";
import {
  buildWorkspaceSurfaceName,
  createWhatsAppWorkspaceTopology,
} from "./workspace-topology.js";

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
 * @param {SubagentMessageEvent} event
 * @returns {string}
 */
function stringifySubagentMessage(event) {
  const title = event.agentNickname
    ? `*Sub-agent ${event.agentNickname}*`
    : "*Sub-agent*";
  const detail = event.agentRole ? `_${event.agentRole}_` : "";
  return [`🧩 ${title}`, detail, event.text].filter(Boolean).join("\n");
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
    case "app_message": {
      const source = appMessageRoleToSource(event.role);
      const text = stringifyContent(event.content);
      const prefix = SOURCE_PREFIX[source];
      return prefix && text ? `${prefix} ${text}` : text;
    }
    case "assistant_output": {
      const text = stringifyContent(event.content);
      return text ? `${SOURCE_PREFIX.llm} ${text}` : text;
    }
    case "agent_tool_result": {
      const text = stringifyContent(event.content);
      return text ? `${SOURCE_PREFIX["tool-result"]} ${text}` : text;
    }
    case "tool_call": {
      const args = parseToolArgs(event.toolCall.arguments);
      const presentation = buildToolPresentation(
        event.toolCall.name,
        args,
        typeof event.displaySummary === "string" ? () => event.displaySummary ?? "" : undefined,
        event.cwd ?? null,
        event.context,
      );
      return presentation
        ? `${SOURCE_PREFIX["tool-call"]} ${renderToolPresentationContent(presentation)}`.trim()
        : "";
    }
    case "tool_activity":
      return `${SOURCE_PREFIX["tool-call"]} ${renderToolActivityContent(event.activity)}`.trim();
    case "plan":
      return `${SOURCE_PREFIX.llm} ${formatPlanPresentationText(event.presentation)}`.trim();
    case "file_change": {
      const rendered = renderFileChangeContent(event);
      return `${SOURCE_PREFIX["tool-call"]} ${stringifyContent(rendered)}`.trim();
    }
    case "usage":
      return `${SOURCE_PREFIX.usage} ${formatUsageEventText(event)}`;
    case "subagent_message":
      return stringifySubagentMessage(event);
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
 *     "getWhatsAppWorkspacePresentation"
 *     | "saveWhatsAppWorkspacePresentation">,
 * }} input
 * @returns {WorkspacePresentationPort}
 */
export function createWhatsAppWorkspacePresenter({ transport, store }) {
  const topology = createWhatsAppWorkspaceTopology({ transport, store });

  /**
   * @param {string} workspaceId
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function sendPlainWorkspaceContent(workspaceId, text) {
    const appOutput = createAppOutputPort({
      send: (event) => presenter.sendWorkspaceEvent({ workspaceId, event }).then(() => undefined),
      reply: (event) => presenter.sendWorkspaceEvent({ workspaceId, event }).then(() => undefined),
    });
    await appOutput.sendPlain([{ type: "text", text }]);
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
    async ensureWorkspaceVisible({ projectId, projectName, workspaceId, workspaceName, sourceChatId, requesterJids }) {
      const existing = await store.getWhatsAppWorkspacePresentation(workspaceId);

      if (existing) {
        const role = existing.role ?? /** @type {WhatsAppWorkspacePresentationRole} */ ("workspace");
        const linkedCommunityChatId = existing.linked_community_chat_id ?? null;
        if (linkedCommunityChatId && role === "main") {
          return topology.syncMainWorkspaceCommunitySurface({
            projectId,
            projectName,
            workspaceId,
            existingWorkspacePresentation: existing,
            communityChatId: linkedCommunityChatId,
          });
        }
        const surfaceName = buildWorkspaceSurfaceName(projectName, workspaceName, { projectId, role });
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
          projectId,
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

      return topology.provisionWorkspaceSurface({
        projectId,
        projectName,
        workspaceId,
        workspaceName,
        sourceChatId,
        requesterJids,
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
