export default /** @type {defineAction} */ ((x) => x)({
  name: "get_model",
  command: "get-model",
  description: "Get the current LLM model for a chat (admin only)",
  parameters: {
    type: "object",
    properties: {},
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb }) {
    const targetChatId = chatId;

    // First check if chat exists
    const {
      rows: [chatInfo],
    } =
      await rootDb.sql`SELECT chat_id, model FROM chats WHERE chat_id = ${targetChatId}`;

    if (!chatInfo) {
      throw new Error(`Chat ${targetChatId} does not exist.`);
    }

    // Get the model or indicate default is being used
    if (chatInfo.model) {
      return `*Custom model for chat ${targetChatId}:*\n\n${chatInfo.model}`;
    } else {
      return `*Chat ${targetChatId} is using the default model:*\n\n${(await import("../config.js")).default.model}`;
    }
  },
});
