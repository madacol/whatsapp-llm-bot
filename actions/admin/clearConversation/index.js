
import { isSqliteDb } from "../../../sqlite-db.js";

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
    useChatDb: true,
  },
  action_fn: async function ({ chatId, chatDb }) {
    if (isSqliteDb(chatDb)) {
      await chatDb.sql`UPDATE messages SET cleared_at = ${new Date().toISOString()} WHERE chat_id = ${chatId} AND cleared_at IS NULL`;
    } else {
      await chatDb.sql`UPDATE messages SET cleared_at = NOW() WHERE chat_id = ${chatId} AND cleared_at IS NULL`;
    }
    return "🗑️ Conversation history cleared!";
  },
});
