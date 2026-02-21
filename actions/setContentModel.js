import assert from "node:assert/strict";
import { modelExists, findClosestModels, getModelModalities } from "../models-cache.js";

const CONTENT_TYPES = ["image", "audio", "video"];

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_content_model",
  command: "set content-model",
  description:
    "Set the model used to translate a specific content type (image/audio/video) to text for non-multimodal chat models (admin only).",
  parameters: {
    type: "object",
    properties: {
      contentType: {
        type: "string",
        enum: CONTENT_TYPES,
        description:
          "The content type to set the translation model for (image, audio, or video).",
      },
      model: {
        type: "string",
        description: "The model ID to use for translating content to text",
      },
    },
    required: ["contentType", "model"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function sets_content_model_for_specific_type(action_fn, db) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
          {
            id: "openai/gpt-4o",
            name: "GPT-4o",
            context_length: 128000,
            pricing: { prompt: "0.000005", completion: "0.000015" },
            architecture: { input_modalities: ["text", "image"] },
          },
        ]),
      );

      try {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('act-scm-2') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "act-scm-2", rootDb: db },
          { model: "openai/gpt-4o", contentType: "image" },
        );
        assert.ok(typeof result === "string");
        assert.ok(result.includes("image"));

        const {
          rows: [chat],
        } = await db.sql`SELECT content_models FROM chats WHERE chat_id = 'act-scm-2'`;
        const models = chat.content_models;
        assert.equal(models.image, "openai/gpt-4o");
        assert.equal(models.audio, undefined);
        assert.equal(models.video, undefined);
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    },

    async function rejects_invalid_model(action_fn, db) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify([]));

      try {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('act-scm-3') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "act-scm-3", rootDb: db },
          { model: "nonexistent/model", contentType: "image" },
        );
        assert.ok(typeof result === "string");
        assert.ok(result.includes("not found"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    },

    async function validates_model_supports_content_type(action_fn, db) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
          {
            id: "text-only/model",
            name: "Text Only",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text"] },
          },
        ]),
      );

      try {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('act-scm-4') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "act-scm-4", rootDb: db },
          { model: "text-only/model", contentType: "image" },
        );
        assert.ok(typeof result === "string");
        assert.ok(result.includes("does not support"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    },
  ],
  action_fn:
    /**
     * @param {{ chatId: string, rootDb: PGlite }} context
     * @param {{ model: string, contentType: "image" | "audio" | "video" }} params
     */
    async function ({ chatId, rootDb }, { model, contentType }) {
      model = model.trim();

      const {
        rows: [chatExists],
      } = await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

      if (!chatExists) {
        throw new Error(`Chat ${chatId} does not exist.`);
      }

      // Validate model exists
      if (!(await modelExists(model))) {
        const suggestions = await findClosestModels(model);
        let message = `Model \`${model}\` not found in OpenRouter models.`;
        if (suggestions.length > 0) {
          message += `\n\nDid you mean:\n${suggestions.map((s) => `• \`${s}\``).join("\n")}`;
        }
        message += `\n\nUse *!search models* to browse available models.`;
        return message;
      }

      // Validate model supports the content type
      const modalities = await getModelModalities(model);
      if (!modalities.includes(contentType)) {
        return `Model \`${model}\` does not support \`${contentType}\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      // Read current content_models
      const {
        rows: [chat],
      } = await rootDb.sql`SELECT content_models FROM chats WHERE chat_id = ${chatId}`;
      const currentModels = chat?.content_models ?? {};

      currentModels[contentType] = model;

      await rootDb.sql`
        UPDATE chats
        SET content_models = ${JSON.stringify(currentModels)}::jsonb
        WHERE chat_id = ${chatId}
      `;

      return `Content model for *${contentType}* set to \`${model}\``;
    },
});
