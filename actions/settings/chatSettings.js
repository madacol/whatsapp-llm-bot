import assert from "node:assert/strict";
import config from "../../config.js";
import { validateModel, getModelModalities } from "../../models-cache.js";
import { getChatOrThrow } from "../../store.js";
import { withModelsCache } from "../../tests/helpers.js";

const SETTINGS = [
  "model",
  "system_prompt",
  "memory",
  "memory_threshold",
  "respond_on",
  "content_model_image",
  "content_model_audio",
  "content_model_video",
];

const RESPOND_ON_VALUES = ["any", "mention+reply", "mention"];

/**
 * Parse a string-or-boolean to a boolean.
 * @param {unknown} raw
 * @returns {boolean}
 */
function toBool(raw) {
  if (typeof raw === "boolean") return raw;
  return String(raw).toLowerCase() === "true";
}

/**
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} setting
 * @returns {Promise<string>}
 */
async function getSetting(rootDb, chatId, setting) {
  const chat = await getChatOrThrow(rootDb, chatId);

  switch (setting) {
    case "model":
      return chat.model
        ? `Model: \`${chat.model}\``
        : `Model (default): \`${config.model}\``;
    case "system_prompt":
      return chat.system_prompt
        ? `Prompt: ${chat.system_prompt}`
        : `Prompt (default): ${config.system_prompt}`;
    case "memory":
      return `Memory: ${chat.memory ? "enabled" : "disabled"}`;
    case "memory_threshold":
      return `Memory threshold: ${chat.memory_threshold ?? config.memory_threshold}`;
    case "respond_on":
      return `Respond on: ${chat.respond_on ?? "mention"}`;
    case "content_model_image":
    case "content_model_audio":
    case "content_model_video": {
      const type = setting.replace("content_model_", "");
      const models = chat.content_models ?? {};
      const model = models[/** @type {"image"|"audio"|"video"} */ (type)];
      return model
        ? `Content model (${type}): \`${model}\``
        : `Content model (${type}): not set`;
    }
    default:
      return `Unknown setting: ${setting}`;
  }
}

/**
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} setting
 * @param {string} value
 * @returns {Promise<string>}
 */
async function setSetting(rootDb, chatId, setting, value) {
  const chat = await getChatOrThrow(rootDb, chatId);

  switch (setting) {
    case "model": {
      const trimmed = value.trim();
      const modelValue = trimmed.length === 0 ? null : trimmed;
      if (modelValue) {
        const error = await validateModel(modelValue);
        if (error) return error;
      }
      await rootDb.sql`UPDATE chats SET model = ${modelValue} WHERE chat_id = ${chatId}`;
      return modelValue
        ? `Model set to \`${modelValue}\``
        : `Model reverted to default (\`${config.model}\`)`;
    }

    case "system_prompt": {
      const trimmed = value.trim();
      const newPrompt = trimmed.length === 0 ? null : trimmed;
      await rootDb.sql`UPDATE chats SET system_prompt = ${newPrompt} WHERE chat_id = ${chatId}`;
      return newPrompt === null
        ? "Prompt cleared, using default."
        : `Prompt set to: ${trimmed}`;
    }

    case "memory": {
      const enabled = toBool(value);
      await rootDb.sql`UPDATE chats SET memory = ${enabled} WHERE chat_id = ${chatId}`;
      return `Long-term memory ${enabled ? "enabled" : "disabled"} for this chat.`;
    }

    case "memory_threshold": {
      const threshold = parseFloat(value);
      if (isNaN(threshold) || threshold < 0 || threshold > 1) {
        throw new Error("Threshold must be a number between 0 and 1.");
      }
      await rootDb.sql`UPDATE chats SET memory_threshold = ${threshold} WHERE chat_id = ${chatId}`;
      return `Memory similarity threshold set to ${threshold} for this chat.`;
    }

    case "respond_on": {
      const trimmed = value.trim().toLowerCase();
      if (!RESPOND_ON_VALUES.includes(trimmed)) {
        return `Invalid value. Must be one of: ${RESPOND_ON_VALUES.join(", ")}`;
      }
      await rootDb.sql`UPDATE chats SET respond_on = ${trimmed} WHERE chat_id = ${chatId}`;
      return `Respond on: ${trimmed}`;
    }

    case "content_model_image":
    case "content_model_audio":
    case "content_model_video": {
      const type = /** @type {"image"|"audio"|"video"} */ (setting.replace("content_model_", ""));
      const trimmed = value.trim();

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes(type)) {
        return `Model \`${trimmed}\` does not support \`${type}\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      const currentModels = chat.content_models ?? {};
      currentModels[type] = trimmed;
      await rootDb.sql`
        UPDATE chats
        SET content_models = ${JSON.stringify(currentModels)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      return `Content model for *${type}* set to \`${trimmed}\``;
    }

    default:
      return `Unknown setting: ${setting}`;
  }
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "chat_settings",
  command: "config",
  description:
    "Get or set chat settings. Available settings: model, system_prompt, memory, memory_threshold, respond_on, content_model_image, content_model_audio, content_model_video. Omit value to see current setting.",
  parameters: {
    type: "object",
    properties: {
      setting: {
        type: "string",
        enum: SETTINGS,
        description: "The setting to get or set",
      },
      value: {
        type: "string",
        description: "The value to set (omit to get current value)",
      },
    },
    required: ["setting"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    // ── model ──
    async function sets_model_for_chat(action_fn, db) {
      await withModelsCache([
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-model-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-model-1", rootDb: db },
          { setting: "model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("openai/gpt-4o"));
        const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'cs-model-1'`;
        assert.equal(chat.model, "openai/gpt-4o");
      });
    },
    async function reverts_model_to_default(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('cs-model-2', 'gpt-4o') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-model-2", rootDb: db },
        { setting: "model", value: "" },
      );
      assert.ok(result.includes("default"));
      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'cs-model-2'`;
      assert.equal(chat.model, null);
    },
    async function gets_model_value(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('cs-model-3', 'custom/m') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-model-3", rootDb: db },
        { setting: "model" },
      );
      assert.ok(result.includes("custom/m"));
    },
    async function gets_default_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-model-4') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-model-4", rootDb: db },
        { setting: "model" },
      );
      assert.ok(result.includes("default"));
    },

    // ── system_prompt ──
    async function sets_system_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-prompt-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-1", rootDb: db },
        { setting: "system_prompt", value: "Be a pirate" },
      );
      assert.ok(result.includes("pirate"));
      const { rows: [chat] } = await db.sql`SELECT system_prompt FROM chats WHERE chat_id = 'cs-prompt-1'`;
      assert.equal(chat.system_prompt, "Be a pirate");
    },
    async function clears_system_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, system_prompt) VALUES ('cs-prompt-2', 'old') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-2", rootDb: db },
        { setting: "system_prompt", value: "  " },
      );
      assert.ok(result.toLowerCase().includes("clear") || result.toLowerCase().includes("default"));
      const { rows: [chat] } = await db.sql`SELECT system_prompt FROM chats WHERE chat_id = 'cs-prompt-2'`;
      assert.equal(chat.system_prompt, null);
    },
    async function gets_custom_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, system_prompt) VALUES ('cs-prompt-3', 'custom prompt') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-3", rootDb: db },
        { setting: "system_prompt" },
      );
      assert.ok(result.includes("custom prompt"));
    },
    async function gets_default_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-prompt-4') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-4", rootDb: db },
        { setting: "system_prompt" },
      );
      assert.ok(result.includes("default"));
    },

    // ── memory ──
    async function enables_memory(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mem-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-mem-1", rootDb: db },
        { setting: "memory", value: "true" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'cs-mem-1'`;
      assert.equal(chat.memory, true);
      assert.ok(result.toLowerCase().includes("enabled"));
    },
    async function disables_memory(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('cs-mem-2', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-mem-2", rootDb: db },
        { setting: "memory", value: "false" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'cs-mem-2'`;
      assert.equal(chat.memory, false);
      assert.ok(result.toLowerCase().includes("disabled"));
    },

    // ── memory_threshold ──
    async function sets_memory_threshold(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-thresh-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-thresh-1", rootDb: db },
        { setting: "memory_threshold", value: "0.5" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory_threshold FROM chats WHERE chat_id = 'cs-thresh-1'`;
      assert.equal(chat.memory_threshold, 0.5);
      assert.ok(result.includes("0.5"));
    },
    async function rejects_out_of_range_threshold(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-thresh-2') ON CONFLICT DO NOTHING`;
      await assert.rejects(
        async () => action_fn({ chatId: "cs-thresh-2", rootDb: db }, { setting: "memory_threshold", value: "1.5" }),
      );
    },

    // ── respond_on ──
    async function sets_respond_on(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-resp-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-resp-1", rootDb: db },
        { setting: "respond_on", value: "mention+reply" },
      );
      assert.ok(result.includes("mention+reply"));
      const { rows: [chat] } = await db.sql`SELECT respond_on FROM chats WHERE chat_id = 'cs-resp-1'`;
      assert.equal(chat.respond_on, "mention+reply");
    },
    async function rejects_invalid_respond_on(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-resp-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-resp-2", rootDb: db },
        { setting: "respond_on", value: "invalid" },
      );
      assert.ok(result.includes("Invalid"));
    },

    // ── content_model_image ──
    async function sets_content_model_image(action_fn, db) {
      await withModelsCache([
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-cm-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-cm-1", rootDb: db },
          { setting: "content_model_image", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("image"));
        const { rows: [chat] } = await db.sql`SELECT content_models FROM chats WHERE chat_id = 'cs-cm-1'`;
        assert.equal(chat.content_models.image, "openai/gpt-4o");
      });
    },
    async function rejects_model_without_modality(action_fn, db) {
      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-cm-2') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-cm-2", rootDb: db },
          { setting: "content_model_image", value: "text-only/model" },
        );
        assert.ok(result.includes("does not support"));
      });
    },

    // ── shows help when no setting provided ──
    async function shows_available_settings_list(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-help-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-help-1", rootDb: db },
        { setting: "" },
      );
      assert.ok(result.includes("model"));
      assert.ok(result.includes("respond_on"));
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { setting, value }) {
    if (!setting || !SETTINGS.includes(setting)) {
      return `Available settings: ${SETTINGS.join(", ")}`;
    }

    if (value === undefined || value === null) {
      return getSetting(rootDb, chatId, setting);
    }

    return setSetting(rootDb, chatId, setting, String(value));
  },
});
