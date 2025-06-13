export default /** @type {defineAction} */ (x=>x)({
  name: "enable_chat",
  command: "enable",
  description: "Enable LLM answers for a specific chat (admin only)",
  parameters: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description: "Chat ID to enable (defaults to current chat if not provided)",
      }
    },
    required: [],
  },
  permissions: {
    autoExecute: true,
    requireRoot: true,
    usePersistentDb: true,
    useRootDb: true,
  },
  action_fn: async function ({ chat, rootDb }, {chatId: paramsChatId}) {
    const chatId = paramsChatId || chat.chatId;
    if (!chatId) {
      throw new Error("Chat ID must be provided or inferred from the message context.");
    }
    // First check if chat exists
    const {rows: [chatExists]} = await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }
    
    // If chat exists, update its is_enabled status
    try {
      await rootDb.sql`
        UPDATE chats
        SET is_enabled = TRUE
        WHERE chat_id = ${chatId}
      `;

      chat.sendMessage(`LLM answers enabled for chat ${chatId}`);
    } catch (error) {
      console.error("Error enabling chat:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error("Failed to enable chat: " + errorMessage);
    }
  }
});