export default /** @type {defineAction} */ ((x) => x)({
  name: "show_info",
  command: "info",
  description: "Show information about the current chat",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    autoExecute: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb }) {
    // Get chat enabled status
    const {
      rows: [chatInfo],
    } =
      await rootDb.sql`SELECT is_enabled FROM chats WHERE chat_id = ${chatId}`;

    if (!chatInfo) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    const status = chatInfo.is_enabled ? "enabled" : "disabled";

    let info = `Chat Information:\n`;
    info += `- Chat ID: ${chatId}\n`;
    // info += `- Chat Name: ${chat.name || 'Private Chat'}\n`;
    // info += `- Type: ${chat.isGroup ? 'Group' : 'Private'}\n`;
    info += `- status: ${status}`;

    return info;
  },
});
