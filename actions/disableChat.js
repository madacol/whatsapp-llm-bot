export default /** @type {defineAction} */ ((x) => x)({
  name: "disable_chat",
  command: "disable",
  description: "Disable LLM answers for a specific chat (admin only)",
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
    requireRoot: true,
    useRootDb: true,
  },
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
