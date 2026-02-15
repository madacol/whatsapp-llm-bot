import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "disable_chat",
  command: "disable",
  description: "Disable LLM answers for a specific chat",
  parameters: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description:
          "Chat ID to disable (defaults to current chat if not provided)",
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
    async function disables_existing_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('act-disable-1', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-disable-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("disabled"));
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'act-disable-1'`;
      assert.equal(chat.is_enabled, false);
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
        SET is_enabled = FALSE
        WHERE chat_id = ${targetChatId}
      `;

      return `LLM answers disabled for chat ${targetChatId}`;
    } catch (error) {
      console.error("Error disabling chat:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to disable chat: " + errorMessage);
    }
  },
});
