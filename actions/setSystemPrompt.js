import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_system_prompt",
  command: "set-prompt",
  description: "Set a custom system prompt for a chat (admin only)",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The system prompt to set for the chat",
      },
    },
    required: ["prompt"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function sets_system_prompt_for_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-prompt-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-prompt-1", rootDb: db },
        { prompt: "Be a pirate" },
      );
      assert.ok(result.includes("pirate"));
      const { rows: [chat] } = await db.sql`SELECT system_prompt FROM chats WHERE chat_id = 'act-prompt-1'`;
      assert.equal(chat.system_prompt, "Be a pirate");
    },
    async function throws_on_empty_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-prompt-2') ON CONFLICT DO NOTHING`;
      await assert.rejects(
        () => action_fn({ chatId: "act-prompt-2", rootDb: db }, { prompt: "  " }),
        { message: /empty/ },
      );
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { prompt }) {
    const targetChatId = chatId;
    prompt = prompt.trim();

    if (!prompt || prompt.length === 0) {
      throw new Error("System prompt cannot be empty");
    }

    // First check if chat exists
    const {
      rows: [chatExists],
    } =
      await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${targetChatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${targetChatId} does not exist.`);
    }

    // Update the system prompt for the chat
    try {
      await rootDb.sql`
        UPDATE chats
        SET system_prompt = ${prompt}
        WHERE chat_id = ${targetChatId}
      `;

      return `✅ System prompt updated for chat ${targetChatId}\n\n*New prompt:*\n${prompt}`;
    } catch (error) {
      console.error("Error setting system prompt:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to set system prompt: " + errorMessage);
    }
  },
});
