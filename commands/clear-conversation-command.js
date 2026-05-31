import { getChatDb } from "../db.js";

export const CLEAR_CONVERSATION_COMMAND_PARAMETERS = /** @type {Action["parameters"]} */ ({
  type: "object",
  properties: {},
  required: [],
});

/**
 * @param {ExecuteActionContext} context
 * @returns {Promise<string>}
 */
export async function runClearConversationCommand(context) {
  const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
  if (!isAdmin) {
    return "Only admins can clear conversation history.";
  }
  const chatDb = getChatDb(context.chatId);
  await chatDb.sql`UPDATE messages SET cleared_at = ${new Date()} WHERE chat_id = ${context.chatId} AND cleared_at IS NULL`;
  return "Conversation history cleared.";
}
