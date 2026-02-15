import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "new_conversation",
  command: "new",
  description: "Clear conversation history for the current chat",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    requireAdmin: true,
    autoExecute: true,
    useRootDb: true,
  },
  test_functions: [
    async function clears_messages_for_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-new-1') ON CONFLICT DO NOTHING`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-new-1', 's1', '{"role":"user","content":[{"type":"text","text":"hi"}]}')`;
      const { rows: before } = await db.sql`SELECT * FROM messages WHERE chat_id = 'act-new-1'`;
      assert.equal(before.length, 1);
      const result = await action_fn(
        { chatId: "act-new-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("clear"));
      const { rows: afterClear } = await db.sql`SELECT * FROM messages WHERE chat_id = 'act-new-1'`;
      assert.equal(afterClear.length, 0);
    },
  ],
  action_fn: async function ({ chatId, rootDb }) {
    try {
      await rootDb.sql`DELETE FROM messages WHERE chat_id = ${chatId}`;
      return "🗑️ Conversation history cleared!";
    } catch (error) {
      console.error("Error clearing conversation:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to clear conversation: " + errorMessage);
    }
  },
});
