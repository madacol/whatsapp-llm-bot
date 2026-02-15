import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "get_model",
  command: "get model",
  description: "Get the current LLM model for a chat (admin only)",
  parameters: {
    type: "object",
    properties: {},
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function returns_custom_model_when_set(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('act-gmodel-1', 'gpt-4o') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-gmodel-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("gpt-4o"));
    },
    async function indicates_default_when_no_custom_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-gmodel-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-gmodel-2", rootDb: db },
        {},
      );
      assert.ok(result.includes("default"));
    },
  ],
  action_fn: async function ({ chatId, rootDb }) {
    const targetChatId = chatId;

    // First check if chat exists
    const {
      rows: [chatInfo],
    } =
      await rootDb.sql`SELECT chat_id, model FROM chats WHERE chat_id = ${targetChatId}`;

    if (!chatInfo) {
      throw new Error(`Chat ${targetChatId} does not exist.`);
    }

    // Get the model or indicate default is being used
    if (chatInfo.model) {
      return `*Custom model for chat ${targetChatId}:*\n\n${chatInfo.model}`;
    } else {
      return `*Chat ${targetChatId} is using the default model:*\n\n${(await import("../config.js")).default.model}`;
    }
  },
});
