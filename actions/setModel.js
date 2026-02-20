import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_model",
  command: "set model",
  description: "Set a custom LLM model for a chat (admin only). Use an empty value to revert to the global default.",
  parameters: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description: "The model name to set for the chat (empty to revert to default)",
      },
    },
    required: ["model"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function sets_model_for_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-smodel-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-smodel-1", rootDb: db },
        { model: "gpt-4o" },
      );
      assert.ok(result.includes("gpt-4o"));
      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'act-smodel-1'`;
      assert.equal(chat.model, "gpt-4o");
    },
    async function reverts_to_default_on_empty_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('act-smodel-2', 'gpt-4o') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-smodel-2", rootDb: db },
        { model: "" },
      );
      assert.ok(result.includes("default"));
      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'act-smodel-2'`;
      assert.equal(chat.model, null);
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { model }) {
    model = model.trim();

    const {
      rows: [chatExists],
    } =
      await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    const modelValue = model.length === 0 ? null : model;

    try {
      await rootDb.sql`
        UPDATE chats
        SET model = ${modelValue}
        WHERE chat_id = ${chatId}
      `;

      if (modelValue) {
        return `✅ Model updated for chat ${chatId}\n\n*New model:*\n${modelValue}`;
      } else {
        const defaultModel = (await import("../config.js")).default.model;
        return `✅ Model reverted to default for chat ${chatId}\n\n*Default model:*\n${defaultModel}`;
      }
    } catch (error) {
      console.error("Error setting model:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to set model: " + errorMessage);
    }
  },
});
