
export default /** @type {defineAction} */ ((x) => x)({
  name: "clear_conversation",
  command: "clear",
  description: "Clear conversation history for the current chat",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  formatToolCall: () => "Clearing conversation",
  permissions: {
    requireAdmin: true,
    autoExecute: true,
    autoContinue: true,
    silent: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb }) {
    await rootDb.sql`UPDATE messages SET cleared_at = NOW() WHERE chat_id = ${chatId} AND cleared_at IS NULL`;
    return "🗑️ Conversation history cleared!";
  },
});
