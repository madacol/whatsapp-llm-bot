import assert from "node:assert/strict";

/** @type {Record<string, string>} */
const ROLE_ICONS = { user: "\u{1F464}", assistant: "\u{1F916}", tool: "\u{1F527}" };

/**
 * Extract readable text from a message_data object.
 * @param {{ role: string, content: Array<Record<string, unknown>>, tool_id?: string }} msg
 * @returns {string}
 */
function formatMessage(msg) {
  const icon = ROLE_ICONS[msg.role] || "\u{2753}";
  const parts = [];

  for (const block of msg.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool" && typeof block.name === "string") {
      const args = typeof block.arguments === "string" ? block.arguments : "";
      let parsed = "";
      try {
        const obj = JSON.parse(args);
        parsed = Object.entries(obj)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
      } catch {
        parsed = args ? `  ${args}` : "";
      }
      parts.push(`*${block.name}*\n${parsed}`.trim());
    } else if (block.type === "quote" && Array.isArray(block.content)) {
      const quoteText = block.content
        .filter((/** @type {Record<string, unknown>} */ b) => b.type === "text" && typeof b.text === "string")
        .map((/** @type {{ text: string }} */ b) => b.text)
        .join("\n");
      if (quoteText) parts.push(`> ${quoteText.split("\n").join("\n> ")}`);
    }
  }

  if (msg.role === "tool" && msg.tool_id) {
    // Tool results: show cleaned text
    const cleaned = parts.map((p) => p.replace(/^"|"$/g, "").replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    return `${icon} *Tool result:*\n${cleaned.join("\n")}`;
  }

  const label = msg.role === "user" ? "User" : msg.role === "assistant" ? "Bot" : msg.role;
  return `${icon} *${label}:*\n${parts.join("\n")}`;
}

/**
 * Format a timestamp for display.
 * @param {string | Date} ts
 * @returns {string}
 */
function formatTimestamp(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return `${month}/${day} ${hours}:${minutes}`;
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "show_conversation",
  command: "history",
  description: "Show the conversation history for the current chat in a readable format",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of messages to show (default: 20)",
      },
    },
    required: [],
  },
  permissions: {
    autoExecute: true,
    useRootDb: true,
  },
  test_functions: [
    async function returns_empty_when_no_messages(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-hist-1') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-hist-1'`;
      const result = await action_fn(
        { chatId: "act-hist-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("No conversation history"));
    },

    async function formats_user_messages_readably(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-hist-2') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-hist-2'`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-hist-2', 'u1', '{"role":"user","content":[{"type":"text","text":"hello world"}]}')`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-hist-2', null, '{"role":"assistant","content":[{"type":"text","text":"hi there"}]}')`;
      const result = await action_fn(
        { chatId: "act-hist-2", rootDb: db },
        {},
      );
      assert.ok(result.includes("*User:*"), "should have User label");
      assert.ok(result.includes("hello world"), "should have user text");
      assert.ok(result.includes("*Bot:*"), "should have Bot label");
      assert.ok(result.includes("hi there"), "should have bot text");
      // Should NOT contain raw JSON
      assert.ok(!result.includes('"role"'), "should not show raw JSON role key");
    },

    async function formats_tool_calls_readably(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-hist-tc') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-hist-tc'`;
      const toolCallMsg = JSON.stringify({
        role: "assistant",
        content: [{
          name: "set_reminder",
          type: "tool",
          tool_id: "tool_123",
          arguments: '{"action":"set","reminder_text":"buy milk"}',
        }],
      });
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-hist-tc', null, ${toolCallMsg})`;
      const result = await action_fn(
        { chatId: "act-hist-tc", rootDb: db },
        {},
      );
      assert.ok(result.includes("*set_reminder*"), "should show tool name bold");
      assert.ok(result.includes("buy milk"), "should show tool args");
    },

    async function formats_tool_results_readably(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-hist-tr') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-hist-tr'`;
      const toolResultMsg = JSON.stringify({
        role: "tool",
        tool_id: "tool_123",
        content: [{ text: '"Reminder set (ID: 3)\\n*What:* buy milk"', type: "text" }],
      });
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-hist-tr', null, ${toolResultMsg})`;
      const result = await action_fn(
        { chatId: "act-hist-tr", rootDb: db },
        {},
      );
      assert.ok(result.includes("*Tool result:*"), "should label as tool result");
      assert.ok(result.includes("Reminder set"), "should show result text");
    },

    async function respects_limit_param(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-hist-3') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-hist-3'`;
      for (let i = 0; i < 5; i++) {
        await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-hist-3', 'u1', ${JSON.stringify({ role: "user", content: [{ type: "text", text: `msg${i}` }] })})`;
      }
      const result = await action_fn(
        { chatId: "act-hist-3", rootDb: db },
        { limit: 2 },
      );
      assert.ok(result.includes("msg4"));
      assert.ok(result.includes("msg3"));
      assert.ok(!result.includes("msg0"));
    },

    async function shows_timestamp_formatted(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-hist-ts') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-hist-ts'`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-hist-ts', 'u1', '{"role":"user","content":[{"type":"text","text":"test"}]}')`;
      const result = await action_fn(
        { chatId: "act-hist-ts", rootDb: db },
        {},
      );
      // Should have a formatted time, not the full ugly UTC string
      assert.ok(!result.includes("Coordinated Universal Time"), "should not show raw UTC string");
    },
  ],
  action_fn: async function ({ chatId, rootDb }, params) {
    const limit = params.limit || 20;
    const { rows } = await rootDb.sql`
      SELECT message_id, sender_id, message_data, timestamp
      FROM messages
      WHERE chat_id = ${chatId}
        AND cleared_at IS NULL
      ORDER BY message_id DESC
      LIMIT ${limit}
    `;

    if (rows.length === 0) {
      return "No conversation history found for this chat.";
    }

    // Reverse to show oldest first
    rows.reverse();

    const lines = rows.map((row) => {
      const msg = row.message_data;
      const ts = row.timestamp ? formatTimestamp(row.timestamp) : "";
      const body = (msg && typeof msg === "object" && Array.isArray(msg.content))
        ? formatMessage(msg)
        : JSON.stringify(msg);
      return `${ts}\n${body}`;
    });

    return `*Conversation history* (${rows.length} messages):\n\n${lines.join("\n\n---\n\n")}`;
  },
});
