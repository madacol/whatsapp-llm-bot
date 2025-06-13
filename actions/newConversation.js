export default /** @type {defineAction} */ (x=>x)({
  name: "new_conversation",
  command: "new",
  description: "Clear conversation history for the current chat",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    requireAdmin: true,
    autoExecute: true,
    useChatDb: true,
  },
  action_fn: async function ({ chat, chatDb }) {

    try {
      await chatDb.sql`DELETE FROM messages WHERE chat_id = ${chat.chatId}`;
      return "🗑️ Conversation history cleared!";
    } catch (error) {
      console.error("Error clearing conversation:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error("Failed to clear conversation: " + errorMessage);
    }
  }
});