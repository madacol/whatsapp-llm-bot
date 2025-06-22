export default /** @type {defineAction} */ ((x) => x)({
  name: "get_system_prompt",
  command: "get-prompt",
  description: "Get the current system prompt for a chat (admin only)",
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
      await rootDb.sql`SELECT chat_id, system_prompt FROM chats WHERE chat_id = ${targetChatId}`;

    if (!chatInfo) {
      throw new Error(`Chat ${targetChatId} does not exist.`);
    }

    // Get the system prompt or indicate default is being used
    if (chatInfo.system_prompt) {
      return `*Custom system prompt for chat ${targetChatId}:*\n\n${chatInfo.system_prompt}`;
    } else {
      return `*Chat ${targetChatId} is using the default system prompt:*\n\n${(await import("../config.js")).default.system_prompt}`;
    }
  },
});
