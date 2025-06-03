

export default /** @type {defineAction} */ (x=>x)({
  name: "enable_chat",
  command: "enable",
  description: "Enable LLM answers for a specific chat (admin only)",
  parameters: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description: "Chat ID to enable (defaults to current chat if not provided)",
      },
      args: {
        type: "array",
        description: "Command line arguments (for !enable command)",
        items: { type: "string" }
      }
    },
    required: [],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true
  },
  /**
   * Enable chat for bot responses
   * @param {Context} context - The context object
   * @param {{chatId?: string, args?: string[]}} params - Parameters
   * @returns {Promise<string>} Success message
   */
  action_fn: async function (context, params) {
    const { message, sql } = context;
    const chatId = params.chatId || (params.args && params.args[0]) || message.from;
    
    // First check if chat exists
    const [chatExists] = await sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }
    
    // If chat exists, update its is_enabled status
    try {
      await sql`
        UPDATE chats 
        SET is_enabled = TRUE
        WHERE chat_id = ${chatId}
      `;
      
      return `LLM answers enabled for chat ${chatId}`;
    } catch (error) {
      console.error("Error enabling chat:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error("Failed to enable chat: " + errorMessage);
    }
  }
});