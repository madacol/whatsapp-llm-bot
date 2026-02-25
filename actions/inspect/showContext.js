import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "show_context",
  command: "context",
  description: "Show the full LLM request context (system prompt, messages, tools, model) from the most recent bot response in this chat.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    autoExecute: true,
    useRootDb: true,
  },
  test_functions: [
    async function returns_stored_context(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-ctx-1') ON CONFLICT DO NOTHING`;

      const llmContext = {
        model: "gpt-4.1",
        system_prompt: "You are a helpful bot.",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
        tools: ["run_javascript", "web_search"],
      };

      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, llm_context)
        VALUES ('act-ctx-1', 'bot', '{"role":"assistant","content":[{"type":"text","text":"Hi"}]}', ${JSON.stringify(llmContext)})`;

      const result = await action_fn({ chatId: "act-ctx-1", rootDb: db }, {});
      assert.ok(result.includes("gpt-4.1"), `Should include model, got: ${result.slice(0, 200)}`);
      assert.ok(result.includes("You are a helpful bot"), "Should include system prompt");
      assert.ok(result.includes("run_javascript"), "Should include tool names");
      assert.ok(result.includes("Hello"), "Should include message content");
    },
    async function returns_no_context_message(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-ctx-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn({ chatId: "act-ctx-2", rootDb: db }, {});
      assert.ok(result.toLowerCase().includes("no context"), "Should indicate no context found");
    },
  ],
  action_fn: async function ({ chatId, rootDb }) {
    const { rows } = await rootDb.sql`
      SELECT llm_context FROM messages
      WHERE chat_id = ${chatId} AND llm_context IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `;

    if (rows.length === 0 || !rows[0].llm_context) {
      return "No context found. Send a message to the bot first, then try again within 1 hour.";
    }

    const ctx = rows[0].llm_context;

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
        counts[msg.role] = (counts[msg.role] || 0) + 1;
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
        const toolInfo = msg.tool_calls
          ? " → " + msg.tool_calls.map((/** @type {{function: {name: string}}} */ t) => t.function.name).join(", ")
          : "";
        const toolId = msg.tool_call_id ? ` [${msg.tool_call_id.slice(-6)}]` : "";
        const truncated = content.length > 300 ? content.slice(0, 300) + "…" : content;
        parts.push(`  [${msg.role}${toolId}] ${truncated}${toolInfo}`);
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
