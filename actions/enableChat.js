import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "enable_chat",
  command: "enable",
  description: "Enable LLM answers for a specific chat (admin only)",
  parameters: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description:
          "Chat ID to enable (defaults to current chat if not provided)",
      },
    },
    required: [],
  },
  permissions: {
    autoExecute: true,
    requireMaster: true,
    useRootDb: true,
  },
  test_functions: [
    async function enables_existing_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-enable-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-enable-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("enabled"));
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'act-enable-1'`;
      assert.equal(chat.is_enabled, true);
    },
    async function throws_if_chat_does_not_exist(action_fn, db) {
      await assert.rejects(
        () => action_fn({ chatId: "nonexistent-enable", rootDb: db }, {}),
        { message: /does not exist/ },
      );
    },
  ],
  action_fn: async function ({ chatId, rootDb }, params) {
    const targetChatId = params.chatId || chatId;

    // First check if chat exists
    const {
      rows: [chatExists],
    } =
      await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${targetChatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${targetChatId} does not exist.`);
    }

    // If chat exists, update its is_enabled status
    try {
      await rootDb.sql`
        UPDATE chats
        SET is_enabled = TRUE
        WHERE chat_id = ${targetChatId}
      `;

      return `LLM answers enabled for chat ${targetChatId}`;
    } catch (error) {
      console.error("Error enabling chat:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to enable chat: " + errorMessage);
    }
  },
});
