export default /** @type {defineAction} */ ((x) => x)({
  name: "set_system_prompt",
  command: "set-prompt",
  description: "Set a custom system prompt for a chat (admin only)",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The system prompt to set for the chat",
      },
    },
    required: ["prompt"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb }, { prompt }) {
    const targetChatId = chatId;
    prompt = prompt.trim();

    if (!prompt || prompt.length === 0) {
      throw new Error("System prompt cannot be empty");
    }

    // First check if chat exists
    const {
      rows: [chatExists],
    } =
      await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${targetChatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${targetChatId} does not exist.`);
    }

    // Update the system prompt for the chat
    try {
      await rootDb.sql`
        UPDATE chats
        SET system_prompt = ${prompt}
        WHERE chat_id = ${targetChatId}
      `;

      return `✅ System prompt updated for chat ${targetChatId}\n\n*New prompt:*\n${prompt}`;
    } catch (error) {
      console.error("Error setting system prompt:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to set system prompt: " + errorMessage);
    }
  },
});
