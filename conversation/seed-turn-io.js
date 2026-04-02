import { markdownToWhatsApp } from "../message-renderer.js";
import { formatPlanPresentationText } from "../plan-presentation.js";
import { formatActivitySummary } from "../tool-presentation-model.js";
import { formatToolPresentationDisplay, formatToolPresentationSummary } from "../presentation/whatsapp.js";

const SEED_SOURCE_PREFIX = /** @type {Record<MessageSource, string>} */ ({
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
function stringifySeedContentBlock(block) {
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
function stringifySeedContent(content) {
  if (typeof content === "string") {
    return content;
  }
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map(stringifySeedContentBlock)
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {OutboundEvent} event
 * @returns {string}
 */
function stringifySeedOutboundEvent(event) {
  switch (event.kind) {
    case "content": {
      const text = stringifySeedContent(event.content);
      const prefix = SEED_SOURCE_PREFIX[event.source];
      return prefix && text ? `${prefix} ${text}` : text;
    }
    case "tool_call":
      return `${SEED_SOURCE_PREFIX["tool-call"]} ${formatToolPresentationDisplay(event.presentation) ?? formatToolPresentationSummary(event.presentation)}`.trim();
    case "tool_activity":
      return `${SEED_SOURCE_PREFIX["tool-call"]} ${formatActivitySummary(event.activity)}`.trim();
    case "plan":
      return `${SEED_SOURCE_PREFIX.llm} ${formatPlanPresentationText(event.presentation)}`.trim();
    case "file_change":
      return `${SEED_SOURCE_PREFIX["tool-call"]} ${event.summary ?? `Changed file: ${event.path}`}`.trim();
    case "usage":
      return `${SEED_SOURCE_PREFIX.usage} Cost: ${event.cost} | prompt=${event.tokens.prompt} cached=${event.tokens.cached} completion=${event.tokens.completion}`;
    default:
      return "";
  }
}

/**
 * Create TurnIO for synthetic seeded turns. Prefer semantic event transport so
 * seeded runs share the same rendering/edit pipeline as real chat turns.
 * Falls back to plain text for transports that only support `sendText`.
 * @param {{
 *   chatId: string,
 *   transport?: Pick<ChatTransport, "sendText"> & Partial<Pick<ChatTransport, "sendEvent">>,
 * }} input
 * @returns {TurnIO}
 */
export function createSeedTurnIo({ chatId, transport }) {
  /**
   * @param {OutboundEvent} event
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function sendSeedEvent(event) {
    if (transport?.sendEvent) {
      return transport.sendEvent(chatId, event);
    }

    const text = stringifySeedOutboundEvent(event).trim();
    if (text) {
      await transport?.sendText(chatId, text);
    }
    return undefined;
  }

  return {
    getIsAdmin: async () => true,
    react: async () => {},
    select: async () => "",
    selectMany: async () => ({ kind: "cancelled" }),
    send: sendSeedEvent,
    reply: sendSeedEvent,
    confirm: async () => false,
    startPresence: async () => {},
    keepPresenceAlive: async () => {},
    endPresence: async () => {},
  };
}
