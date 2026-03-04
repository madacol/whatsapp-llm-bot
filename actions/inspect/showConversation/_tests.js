import assert from "node:assert/strict";

/** @type {ActionDbTestFn[]} */
export default [
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
];
