export default /** @type {defineAction} */ ((x) => x)({
  name: "set_model",
  command: "set-model",
  description: "Set a custom LLM model for a chat (admin only). Use an empty value to revert to the global default.",
  parameters: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description: "The model name to set for the chat (empty to revert to default)",
      },
    },
    required: ["model"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb }, { model }) {
    const targetChatId = chatId;
    model = model.trim();

    // First check if chat exists
    const {
      rows: [chatExists],
    } =
      await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${targetChatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${targetChatId} does not exist.`);
    }

    // If empty, set to null to revert to global default
    const modelValue = model.length === 0 ? null : model;

    // Update the model for the chat
    try {
      await rootDb.sql`
        UPDATE chats
        SET model = ${modelValue}
        WHERE chat_id = ${targetChatId}
      `;

      if (modelValue) {
        return `✅ Model updated for chat ${targetChatId}\n\n*New model:*\n${modelValue}`;
      } else {
        const defaultModel = (await import("../config.js")).default.model;
        return `✅ Model reverted to default for chat ${targetChatId}\n\n*Default model:*\n${defaultModel}`;
      }
    } catch (error) {
      console.error("Error setting model:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to set model: " + errorMessage);
    }
  },
});
