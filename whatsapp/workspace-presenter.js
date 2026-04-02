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
 * @param {{ transport: ChatTransport }} input
 * @returns {WorkspacePresentationPort}
 */
export function createWhatsAppWorkspacePresenter({ transport }) {
  /**
   * @param {string} surfaceId
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function sendPlainWorkspaceContent(surfaceId, text) {
    await presenter.sendWorkspaceEvent({
      surfaceId,
      event: contentEvent("plain", [{ type: "text", text }]),
    });
  }

  /** @type {WorkspacePresentationPort} */
  const presenter = {
    async provisionWorkspaceSurface({ workspaceName, sourceChatName, requesterJids }) {
      if (!transport.createGroup) {
        throw new Error("Workspace creation requires workspace surface provisioning support.");
      }
      const surfaceName = buildWorkspaceSurfaceName(workspaceName, sourceChatName);
      const group = await transport.createGroup(surfaceName, requesterJids);
      if (transport.promoteParticipants && requesterJids.length > 0) {
        await transport.promoteParticipants(group.chatId, requesterJids);
      }
      return {
        surfaceId: group.chatId,
        surfaceName: typeof group.subject === "string" ? group.subject : surfaceName,
      };
    },

    async reopenWorkspaceSurface({ surfaceId, workspaceName, sourceChatName, requesterJids }) {
      const surfaceName = buildWorkspaceSurfaceName(workspaceName, sourceChatName);
      if (transport.renameGroup) {
        await transport.renameGroup(surfaceId, surfaceName);
      }
      if (transport.setAnnouncementOnly) {
        await transport.setAnnouncementOnly(surfaceId, false);
      }
      if (transport.promoteParticipants && requesterJids.length > 0) {
        try {
          await transport.promoteParticipants(surfaceId, requesterJids);
        } catch {
          // Best effort: the requester may not already be in the existing group.
        }
      }
      return { surfaceName };
    },

    async presentWorkspaceBootstrap({ surfaceId, statusText }) {
      await sendPlainWorkspaceContent(surfaceId, statusText);
    },

    async presentSeedPrompt({ surfaceId, promptText }) {
      await sendPlainWorkspaceContent(surfaceId, promptText);
    },

    async sendWorkspaceEvent({ surfaceId, event }) {
      if (transport.sendEvent) {
        return transport.sendEvent(surfaceId, event);
      }
      const text = stringifyEvent(event).trim();
      if (text) {
        await transport.sendText(surfaceId, text);
      }
      return undefined;
    },

    async archiveWorkspaceSurface({ surfaceId, surfaceName }) {
      if (transport.renameGroup) {
        await transport.renameGroup(surfaceId, `${surfaceName} (archived)`);
      }
      if (transport.setAnnouncementOnly) {
        await transport.setAnnouncementOnly(surfaceId, true);
      }
    },
  };

  return presenter;
}
