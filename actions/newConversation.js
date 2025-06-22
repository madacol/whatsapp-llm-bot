export default /** @type {defineAction} */ ((x) => x)({
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
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb }) {
    try {
      await rootDb.sql`DELETE FROM messages WHERE chat_id = ${chatId}`;
      return "🗑️ Conversation history cleared!";
    } catch (error) {
      console.error("Error clearing conversation:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to clear conversation: " + errorMessage);
    }
  },
});
