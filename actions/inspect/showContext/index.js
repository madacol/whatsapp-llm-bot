
export default /** @type {defineAction} */ ((x) => x)({
  name: "show_context",
  command: "context",
  description: "Show the full LLM request context (system prompt, messages, tools, model) from the most recent bot response in this chat.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  formatToolCall: () => "Showing LLM context",
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useChatDb: true,
  },
  action_fn: async function ({ chatId, chatDb }) {
    const { rows } = await chatDb.sql`
      SELECT llm_context FROM messages
      WHERE chat_id = ${chatId} AND llm_context IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `;

    if (rows.length === 0 || !rows[0].llm_context) {
      return "No context found. Send a message to the bot first, then try again within 1 hour.";
    }

    const ctx = normalizeLlmContext(rows[0].llm_context);
    if (!ctx) {
      return "No readable context found for the most recent bot response.";
    }

    /** @type {string[]} */
    const parts = [];

    parts.push(`*Model:* ${ctx.model}`);
    parts.push("");
    parts.push("*System prompt:*");
    parts.push("```");
    parts.push(ctx.system_prompt);
    parts.push("```");

    if (Array.isArray(ctx.messages)) {
      /** @type {Record<string, number>} */
      const counts = {};
      for (const msg of ctx.messages) {
        const role = typeof msg.role === "string" ? msg.role : "unknown";
        counts[role] = (counts[role] || 0) + 1;
      }
      const summary = Object.entries(counts).map(([role, count]) => `${role}: ${count}`).join(", ");
      parts.push("");
      parts.push(`*Messages (${ctx.messages.length}):* ${summary}`);

      for (const msg of ctx.messages) {
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(formatContentPart).join(" ")
            : "";
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map(getToolCallName).filter(Boolean) : [];
        const toolInfo = toolCalls.length > 0
          ? " → " + toolCalls.join(", ")
          : "";
        const toolId = typeof msg.tool_call_id === "string" ? ` [${msg.tool_call_id.slice(-6)}]` : "";
        const truncated = content.length > 300 ? content.slice(0, 300) + "…" : content;
        const role = typeof msg.role === "string" ? msg.role : "unknown";
        parts.push(`  [${role}${toolId}] ${truncated}${toolInfo}`);
      }
    }

    if (Array.isArray(ctx.tools) && ctx.tools.length > 0) {
      parts.push("");
      parts.push(`*Tools (${ctx.tools.length}):* ${ctx.tools.join(", ")}`);
    }

    return parts.join("\n");
  },
});

/**
 * @typedef {{
 *   model: string;
 *   system_prompt: string;
 *   messages?: Array<Record<string, unknown>>;
 *   tools?: string[];
 * }} StoredLlmContext
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {StoredLlmContext | null}
 */
function normalizeLlmContext(value) {
  if (!isRecord(value) || typeof value.model !== "string" || typeof value.system_prompt !== "string") {
    return null;
  }
  const messages = Array.isArray(value.messages)
    ? value.messages.filter(isRecord)
    : undefined;
  const tools = Array.isArray(value.tools)
    ? value.tools.filter((tool) => typeof tool === "string")
    : undefined;
  return {
    model: value.model,
    system_prompt: value.system_prompt,
    ...(messages ? { messages } : {}),
    ...(tools ? { tools } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function getToolCallName(value) {
  if (!isRecord(value) || !isRecord(value.function) || typeof value.function.name !== "string") {
    return null;
  }
  return value.function.name;
}

/**
 * Format a content part for display.
 * @param {Record<string, unknown>} part
 * @returns {string}
 */
function formatContentPart(part) {
  if (part.type === "text") return /** @type {string} */ (part.text);
  if (part.type === "image_url") return String(/** @type {{url: string}} */ (/** @type {unknown} */ (part.image_url)).url);
  if (part.type === "video_url") return String(/** @type {{url: string}} */ (/** @type {unknown} */ (part.video_url)).url);
  if (part.type === "input_audio") return String(/** @type {{data: string}} */ (/** @type {unknown} */ (part.input_audio)).data);
  return `[${part.type}]`;
}
