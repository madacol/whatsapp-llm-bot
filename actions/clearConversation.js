import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "clear_conversation",
  command: "clear",
  description: "Clear conversation history for the current chat",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    requireAdmin: true,
    autoExecute: true,
    silent: true,
    useRootDb: true,
  },
  test_functions: [
    async function marks_messages_as_cleared(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-new-1') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-new-1'`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-new-1', 's1', '{"role":"user","content":[{"type":"text","text":"hi"}]}')`;
      const { rows: before } = await db.sql`SELECT * FROM messages WHERE chat_id = 'act-new-1'`;
      assert.equal(before.length, 1);
      const result = await action_fn(
        { chatId: "act-new-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("clear"));
      // Messages still exist but are marked as cleared
      const { rows: allRows } = await db.sql`SELECT * FROM messages WHERE chat_id = 'act-new-1'`;
      assert.equal(allRows.length, 1, "message should still exist in DB");
      assert.ok(allRows[0].cleared_at, "message should have cleared_at set");
      // But filtered out when querying uncleared
      const { rows: activeRows } = await db.sql`SELECT * FROM messages WHERE chat_id = 'act-new-1' AND cleared_at IS NULL`;
      assert.equal(activeRows.length, 0, "no active messages after clear");
    },
  ],
  action_fn: async function ({ chatId, rootDb }) {
    try {
      await rootDb.sql`UPDATE messages SET cleared_at = NOW() WHERE chat_id = ${chatId} AND cleared_at IS NULL`;
      return "🗑️ Conversation history cleared!";
    } catch (error) {
      console.error("Error clearing conversation:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to clear conversation: " + errorMessage);
    }
  },
});
