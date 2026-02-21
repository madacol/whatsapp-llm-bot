import assert from "node:assert/strict";
import { modelExists, findClosestModels } from "../models-cache.js";

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
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify([
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ]));

      try {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('act-smodel-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "act-smodel-1", rootDb: db },
          { model: "openai/gpt-4o" },
        );
        assert.ok(result.includes("openai/gpt-4o"));
        const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'act-smodel-1'`;
        assert.equal(chat.model, "openai/gpt-4o");
      } finally {
        await fs.rm(cachePath, { force: true });
      }
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

    // Validate model exists in cache (skip for empty/revert)
    if (modelValue && !(await modelExists(modelValue))) {
      const suggestions = await findClosestModels(modelValue);
      let message = `Model \`${modelValue}\` not found in OpenRouter models.`;
      if (suggestions.length > 0) {
        message += `\n\nDid you mean:\n${suggestions.map((s) => `• \`${s}\``).join("\n")}`;
      }
      message += `\n\nUse *!search models* to browse available models.`;
      return message;
    }

    try {
      await rootDb.sql`
        UPDATE chats
        SET model = ${modelValue}
        WHERE chat_id = ${chatId}
      `;

      if (modelValue) {
        return `Model set to ${modelValue}`;
      } else {
        const defaultModel = (await import("../config.js")).default.model;
        return `Model reverted to default (${defaultModel})`;
      }
    } catch (error) {
      console.error("Error setting model:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error("Failed to set model: " + errorMessage);
    }
  },
});
