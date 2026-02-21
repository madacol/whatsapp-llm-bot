import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_system_prompt",
  command: "set prompt",
  description: "Set or clear a custom system prompt for a chat (admin only). Send an empty prompt to reset to default.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The system prompt to set for the chat",
      },
    },
    required: [],
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
    async function clears_system_prompt_with_empty_string(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-prompt-2') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET system_prompt = 'old prompt' WHERE chat_id = 'act-prompt-2'`;
      const result = await action_fn({ chatId: "act-prompt-2", rootDb: db }, { prompt: "  " });
      assert.ok(result.toLowerCase().includes("clear") || result.toLowerCase().includes("reset") || result.toLowerCase().includes("default"));
      const { rows: [chat] } = await db.sql`SELECT system_prompt FROM chats WHERE chat_id = 'act-prompt-2'`;
      assert.equal(chat.system_prompt, null);
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { prompt }) {
    prompt = (prompt || "").trim();

    const {
      rows: [chatExists],
    } =
      await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    const newPrompt = prompt.length === 0 ? null : prompt;

    try {
      await rootDb.sql`
        UPDATE chats
        SET system_prompt = ${newPrompt}
        WHERE chat_id = ${chatId}
      `;

      if (newPrompt === null) {
        return `Prompt cleared, using default.`;
      }

      return `Prompt set to: ${prompt}`;
    } catch (error) {
      console.error("Error setting system prompt:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to set system prompt: " + errorMessage);
    }
  },
});
