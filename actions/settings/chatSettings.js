import assert from "node:assert/strict";
import config from "../../config.js";
import { validateModel, getModelModalities } from "../../models-cache.js";
import { getChatOrThrow } from "../../store.js";
import { ROLE_DEFINITIONS, resolveModel } from "../../model-roles.js";
import { withModelsCache } from "../../tests/helpers.js";

/**
 * Role names that use model_roles JSONB for per-chat overrides.
 * Excludes "chat" (has dedicated `model` column) and *_to_text roles
 * (use `media_to_text_models` JSONB).
 */
const MODEL_ROLE_SETTINGS = Object.keys(ROLE_DEFINITIONS)
  .filter((r) => r !== "chat" && !r.endsWith("_to_text"))
  .map((r) => `${r}_model`);

const SETTINGS = [
  "model",
  "system_prompt",
  "memory",
  "memory_threshold",
  "respond_on",
  "image_to_text_model",
  "audio_to_text_model",
  "video_to_text_model",
  "media_to_text_model",
  ...MODEL_ROLE_SETTINGS,
  "enabled",
  "debug",
  "action",
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
 * Check whether any of the sender IDs is a master user.
 * @param {string[]} senderIds
 * @returns {boolean}
 */
function isMaster(senderIds) {
  return senderIds.some((id) => config.MASTER_IDs.includes(id));
}

/**
 * Show a full summary of all chat settings.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {{ senderIds?: string[] }} extra
 * @returns {Promise<string>}
 */
async function getInfo(rootDb, chatId, extra) {
  const chat = await getChatOrThrow(rootDb, chatId);

  const status = chat.is_enabled ? "enabled" : "disabled";
  const model = chat.model || `${resolveModel("chat")} (default)`;
  const prompt = chat.system_prompt ? "custom (!config system_prompt)" : "default";
  const response = chat.respond_on ?? "mention";

  const memoryOn = chat.memory ? "on" : "off";
  const threshold = chat.memory_threshold ?? config.memory_threshold;

  const debugOn = chat.debug_until && new Date(chat.debug_until) > new Date();
  const debug = debugOn ? "on" : "off";

  const mediaToTextModels = chat.media_to_text_models ?? {};
  const mediaToTextEntries = Object.entries(mediaToTextModels);
  const mediaToTextStr = mediaToTextEntries.length > 0
    ? mediaToTextEntries.map(([type, m]) => `${type}: ${m}`).join(", ")
    : "default";

  const enabledActions = chat.enabled_actions ?? [];
  const optInStr = enabledActions.length > 0 ? enabledActions.join(", ") : "none";

  const modelRoles = chat.model_roles ?? {};
  const roleEntries = Object.entries(modelRoles);
  const roleOverridesStr = roleEntries.length > 0
    ? roleEntries.map(([role, m]) => `${role}: ${m}`).join(", ")
    : "none";

  const senderIds = extra.senderIds ?? [];

  const lines = [
    `*Chat:* ${chatId}`,
    `*Status:* ${status}`,
    `*Sender:* ${senderIds.join(", ")}`,
    `*Model:* ${model}`,
    `*Prompt:* ${prompt}`,
    `*Response:* ${response}`,
    `*Memory:* ${memoryOn} (threshold: ${threshold})`,
    `*Debug:* ${debug}`,
    `*Media-to-text models:* ${mediaToTextStr}`,
    `*Model role overrides:* ${roleOverridesStr}`,
    `*Opt-in actions:* ${optInStr}`,
  ];

  return lines.join("\n");
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
        : `Model (default): \`${resolveModel("chat")}\``;
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
    case "image_to_text_model":
    case "audio_to_text_model":
    case "video_to_text_model": {
      const type = setting.replace("_to_text_model", "");
      const models = chat.media_to_text_models ?? {};
      const model = models[/** @type {"image"|"audio"|"video"} */ (type)];
      return model
        ? `${type}-to-text model: \`${model}\``
        : `${type}-to-text model: not set`;
    }
    case "media_to_text_model": {
      const models = chat.media_to_text_models ?? {};
      const model = models.general;
      return model
        ? `media-to-text model: \`${model}\``
        : `media-to-text model: not set`;
    }
    case "enabled":
      return `Bot: ${chat.is_enabled ? "enabled" : "disabled"}`;
    case "debug": {
      const debugOn = chat.debug_until && new Date(chat.debug_until) > new Date();
      return `Debug: ${debugOn ? "on" : "off"}`;
    }
    case "action": {
      const enabledActions = chat.enabled_actions ?? [];
      return enabledActions.length > 0
        ? `Opt-in actions: ${enabledActions.join(", ")}`
        : "Opt-in actions: none";
    }
    default: {
      if (MODEL_ROLE_SETTINGS.includes(setting)) {
        const roleName = setting.replace(/_model$/, "");
        const roles = chat.model_roles ?? {};
        const override = roles[roleName];
        const def = ROLE_DEFINITIONS[roleName];
        const defaultVal = /** @type {string} */ (config[def.configKey]);
        if (override) {
          return `${roleName} model: \`${override}\``;
        }
        return defaultVal
          ? `${roleName} model (default): \`${defaultVal}\``
          : `${roleName} model: not set`;
      }
      return `Unknown setting: ${setting}`;
    }
  }
}

/**
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} setting
 * @param {string} value
 * @param {{ senderIds?: string[], getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
async function setSetting(rootDb, chatId, setting, value, extra) {
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
        : `Model reverted to default (\`${resolveModel("chat")}\`)`;
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

    case "image_to_text_model":
    case "audio_to_text_model":
    case "video_to_text_model": {
      const type = /** @type {"image"|"audio"|"video"} */ (setting.replace("_to_text_model", ""));
      const trimmed = value.trim();

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes(type)) {
        return `Model \`${trimmed}\` does not support \`${type}\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      const currentModels = chat.media_to_text_models ?? {};
      currentModels[type] = trimmed;
      await rootDb.sql`
        UPDATE chats
        SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      return `${type}-to-text model set to \`${trimmed}\``;
    }

    case "media_to_text_model": {
      const trimmed = value.trim();

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.some(m => ["image", "audio", "video"].includes(m))) {
        return `Model \`${trimmed}\` does not support any media input (image, audio, or video).`;
      }

      const currentModels = chat.media_to_text_models ?? {};
      currentModels.general = trimmed;
      await rootDb.sql`
        UPDATE chats
        SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      return `media-to-text model set to \`${trimmed}\``;
    }

    case "enabled": {
      const senderIds = extra.senderIds ?? [];
      if (!isMaster(senderIds)) {
        return "Only master users can change the enabled setting.";
      }
      const enabled = toBool(value);
      await rootDb.sql`UPDATE chats SET is_enabled = ${enabled} WHERE chat_id = ${chatId}`;
      return `Bot ${enabled ? "enabled" : "disabled"}.`;
    }

    case "debug": {
      const input = value.trim().toLowerCase();

      if (input === "off") {
        await rootDb.sql`UPDATE chats SET debug_until = NULL WHERE chat_id = ${chatId}`;
        return "Debug off.";
      }

      const mins = input === "" ? 10 : Number(input);
      if (Number.isNaN(mins) || mins < 0) {
        return `Invalid value: "${value}". Use a number of minutes, 0 for permanent, or "off" to disable.`;
      }

      if (mins === 0) {
        await rootDb.sql`UPDATE chats SET debug_until = '9999-01-01' WHERE chat_id = ${chatId}`;
        return "Debug on (permanent).";
      }

      const until = new Date(Date.now() + mins * 60 * 1000);
      const untilIso = until.toISOString();
      await rootDb.sql`UPDATE chats SET debug_until = ${untilIso} WHERE chat_id = ${chatId}`;
      const timeStr = until.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `Debug on for ${mins}min (until ${timeStr}).`;
    }

    case "action": {
      // value format: "action_name true" or "action_name false"
      const parts = value.trim().split(/\s+/);
      if (parts.length < 2) {
        return "Usage: !config action <action_name> <true|false>";
      }
      const actionName = parts[0];
      const actionEnabled = toBool(parts[1]);

      const getActions = extra.getActions;
      if (!getActions) {
        return "Internal error: getActions not available.";
      }

      const allActions = await getActions();
      const targetAction = allActions.find((a) => a.name === actionName);
      if (!targetAction) {
        return `Action \`${actionName}\` not found.`;
      }
      if (!targetAction.optIn) {
        return `Action \`${actionName}\` is not an opt-in action.`;
      }

      const { rows: [current] } = await rootDb.sql`SELECT enabled_actions FROM chats WHERE chat_id = ${chatId}`;
      /** @type {string[]} */
      const currentActions = current.enabled_actions ?? [];

      /** @type {string[]} */
      let updated;
      if (actionEnabled) {
        updated = currentActions.includes(actionName) ? currentActions : [...currentActions, actionName];
      } else {
        updated = currentActions.filter(/** @param {string} a */ (a) => a !== actionName);
      }

      await rootDb.sql`UPDATE chats SET enabled_actions = ${JSON.stringify(updated)}::jsonb WHERE chat_id = ${chatId}`;
      return `Action \`${actionName}\` ${actionEnabled ? "enabled" : "disabled"} for this chat.`;
    }

    default: {
      if (MODEL_ROLE_SETTINGS.includes(setting)) {
        const roleName = setting.replace(/_model$/, "");
        const trimmed = value.trim();

        // Clear: empty value removes the per-chat override
        if (trimmed.length === 0) {
          const currentRoles = chat.model_roles ?? {};
          delete currentRoles[roleName];
          await rootDb.sql`
            UPDATE chats
            SET model_roles = ${JSON.stringify(currentRoles)}::jsonb
            WHERE chat_id = ${chatId}
          `;
          const def = ROLE_DEFINITIONS[roleName];
          const defaultVal = /** @type {string} */ (config[def.configKey]);
          return defaultVal
            ? `${roleName} model cleared, reverted to default (\`${defaultVal}\`)`
            : `${roleName} model cleared.`;
        }

        // Validate model
        const error = await validateModel(trimmed);
        if (error) return error;

        const currentRoles = chat.model_roles ?? {};
        currentRoles[roleName] = trimmed;
        await rootDb.sql`
          UPDATE chats
          SET model_roles = ${JSON.stringify(currentRoles)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return `${roleName} model set to \`${trimmed}\``;
      }
      return `Unknown setting: ${setting}`;
    }
  }
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "chat_settings",
  command: "config",
  description:
    `Get or set chat settings. Available settings: ${SETTINGS.join(", ")}. Omit value to see current setting.`,
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

    // ── image_to_text_model ──
    async function sets_image_to_text_model(action_fn, db) {
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
          { setting: "image_to_text_model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("image"));
        const { rows: [chat] } = await db.sql`SELECT media_to_text_models FROM chats WHERE chat_id = 'cs-cm-1'`;
        assert.equal(chat.media_to_text_models.image, "openai/gpt-4o");
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
          { setting: "image_to_text_model", value: "text-only/model" },
        );
        assert.ok(result.includes("does not support"));
      });
    },

    // ── media_to_text_model (general) ──
    async function sets_general_media_to_text_model(action_fn, db) {
      await withModelsCache([
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mtt-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-mtt-1", rootDb: db },
          { setting: "media_to_text_model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("media-to-text model"));
        const { rows: [chat] } = await db.sql`SELECT media_to_text_models FROM chats WHERE chat_id = 'cs-mtt-1'`;
        assert.equal(chat.media_to_text_models.general, "openai/gpt-4o");
      });
    },
    async function rejects_text_only_model_for_general_media_to_text(action_fn, db) {
      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mtt-2') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-mtt-2", rootDb: db },
          { setting: "media_to_text_model", value: "text-only/model" },
        );
        assert.ok(result.includes("does not support"));
      });
    },
    async function gets_general_media_to_text_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mtt-3') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET media_to_text_models = '{"general":"openai/gpt-4o"}'::jsonb WHERE chat_id = 'cs-mtt-3'`;
      const result = await action_fn(
        { chatId: "cs-mtt-3", rootDb: db },
        { setting: "media_to_text_model" },
      );
      assert.ok(result.includes("openai/gpt-4o"));
    },

    // ── info summary when no setting provided ──
    async function shows_full_info_when_no_setting(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('cs-info-1', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        {
          chatId: "cs-info-1",
          rootDb: db,
          senderIds: ["user-1"],
          getIsAdmin: async () => false,
        },
        { setting: "" },
      );
      assert.ok(result.includes("cs-info-1"), "should include chat id");
      assert.ok(result.includes("enabled"), "should include status");
      assert.ok(result.includes("user-1"), "should include sender");
    },
    async function info_shows_model_and_default_label(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-info-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-2", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes(config.model), "should include default model");
      assert.ok(result.includes("default"), "should indicate default");
    },
    async function info_shows_custom_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('cs-info-3', 'custom/model') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-3", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("custom/model"));
    },
    async function info_shows_respond_on(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, respond_on)
        VALUES ('cs-info-4', 'mention+reply') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-4", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("mention+reply"), "should include respond_on value");
    },
    async function info_shows_memory_settings(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, memory, memory_threshold) VALUES ('cs-info-5', true, 0.5) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-5", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.toLowerCase().includes("memory"), "should include memory");
      assert.ok(result.includes("0.5"), "should include threshold");
    },
    async function info_shows_debug_status(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, debug_until) VALUES ('cs-info-6', '9999-01-01') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-6", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.toLowerCase().includes("debug"), "should include debug status");
      assert.ok(result.toLowerCase().includes("on"), "should show debug is on");
    },
    async function info_shows_media_to_text_models(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-info-7') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET media_to_text_models = '{"image":"openai/gpt-4o"}'::jsonb WHERE chat_id = 'cs-info-7'`;
      const result = await action_fn(
        { chatId: "cs-info-7", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("openai/gpt-4o"), "should include media-to-text model");
      assert.ok(result.includes("image"), "should include media type");
    },
    async function info_shows_enabled_opt_in_actions(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-info-8', '["track_purchases"]'::jsonb) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-8", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("track_purchases"), "should include enabled opt-in action");
    },
    async function info_shows_none_when_no_opt_in_actions(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-info-9') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-9", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("none"), "should show none for opt-in actions");
    },

    // ── admin check for writes ──
    async function rejects_set_from_non_admin(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-admin-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-admin-1", rootDb: db, getIsAdmin: async () => false },
        { setting: "memory", value: "true" },
      );
      assert.ok(result.includes("admin"), "should mention admin requirement");
    },
    async function allows_get_from_non_admin(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-admin-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-admin-2", rootDb: db, getIsAdmin: async () => false },
        { setting: "memory" },
      );
      assert.ok(result.toLowerCase().includes("memory"), "should return memory setting");
    },

    // ── enabled (requires master) ──
    async function enables_chat_as_master(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-en-1') ON CONFLICT DO NOTHING`;
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-1", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "true" },
        );
        assert.ok(result.includes("enabled"));
        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'cs-en-1'`;
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function disables_chat_as_master(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('cs-en-2', true) ON CONFLICT DO NOTHING`;
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-2", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "false" },
        );
        assert.ok(result.includes("disabled"));
        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'cs-en-2'`;
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function rejects_enabled_from_non_master(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-en-3') ON CONFLICT DO NOTHING`;
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-3", rootDb: db, senderIds: ["regular-user"] },
          { setting: "enabled", value: "true" },
        );
        assert.ok(result.includes("master"), "should mention master requirement");
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function gets_enabled_status(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('cs-en-4', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-en-4", rootDb: db },
        { setting: "enabled" },
      );
      assert.ok(result.includes("enabled"));
    },

    // ── debug ──
    async function enables_debug_for_default_10_minutes(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-dbg-1') ON CONFLICT DO NOTHING`;
      const before = Date.now();
      const result = await action_fn(
        { chatId: "cs-dbg-1", rootDb: db },
        { setting: "debug", value: "" },
      );
      const after = Date.now();

      assert.ok(result.includes("10"));

      const { rows: [chat] } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'cs-dbg-1'`;
      const debugUntil = new Date(chat.debug_until).getTime();
      const tenMinMs = 10 * 60 * 1000;
      assert.ok(
        debugUntil >= before + tenMinMs - 1000 &&
          debugUntil <= after + tenMinMs + 1000,
        `debug_until should be ~10min in future, got ${chat.debug_until}`,
      );
    },
    async function enables_debug_for_custom_minutes(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-dbg-2') ON CONFLICT DO NOTHING`;
      const before = Date.now();
      const result = await action_fn(
        { chatId: "cs-dbg-2", rootDb: db },
        { setting: "debug", value: "30" },
      );
      const after = Date.now();

      assert.ok(result.includes("30"));

      const { rows: [chat] } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'cs-dbg-2'`;
      const debugUntil = new Date(chat.debug_until).getTime();
      const thirtyMinMs = 30 * 60 * 1000;
      assert.ok(
        debugUntil >= before + thirtyMinMs - 1000 &&
          debugUntil <= after + thirtyMinMs + 1000,
        `debug_until should be ~30min in future, got ${chat.debug_until}`,
      );
    },
    async function permanent_debug_with_zero(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-dbg-3') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-dbg-3", rootDb: db },
        { setting: "debug", value: "0" },
      );

      assert.ok(result.toLowerCase().includes("permanent"));

      const { rows: [chat] } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'cs-dbg-3'`;
      assert.equal(
        new Date(chat.debug_until).toISOString().slice(0, 10),
        "9999-01-01",
      );
    },
    async function disables_debug_with_off(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-dbg-4') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET debug_until = '9999-01-01' WHERE chat_id = 'cs-dbg-4'`;
      const result = await action_fn(
        { chatId: "cs-dbg-4", rootDb: db },
        { setting: "debug", value: "off" },
      );

      assert.ok(result.toLowerCase().includes("off"));

      const { rows: [chat] } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'cs-dbg-4'`;
      assert.equal(chat.debug_until, null);
    },
    async function gets_debug_status(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, debug_until) VALUES ('cs-dbg-5', '9999-01-01') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-dbg-5", rootDb: db },
        { setting: "debug" },
      );
      assert.ok(result.toLowerCase().includes("debug"));
      assert.ok(result.toLowerCase().includes("on"));
    },

    // ── action (opt-in) ──
    async function enables_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-1') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "test_opt", optIn: true },
      ];
      const result = await action_fn(
        { chatId: "cs-act-1", rootDb: db, getActions: mockGetActions },
        { setting: "action", value: "test_opt true" },
      );
      assert.ok(result.includes("enabled"));
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'cs-act-1'`;
      assert.ok(chat.enabled_actions.includes("test_opt"));
    },
    async function disables_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-act-2', '["test_opt"]'::jsonb) ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "test_opt", optIn: true },
      ];
      const result = await action_fn(
        { chatId: "cs-act-2", rootDb: db, getActions: mockGetActions },
        { setting: "action", value: "test_opt false" },
      );
      assert.ok(result.includes("disabled"));
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'cs-act-2'`;
      assert.ok(!chat.enabled_actions.includes("test_opt"));
    },
    async function rejects_non_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-3') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "regular_action" },
      ];
      const result = await action_fn(
        { chatId: "cs-act-3", rootDb: db, getActions: mockGetActions },
        { setting: "action", value: "regular_action true" },
      );
      assert.ok(result.includes("not an opt-in action"));
    },
    async function rejects_unknown_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-4') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => /** @type {Action[]} */ ([]);
      const result = await action_fn(
        { chatId: "cs-act-4", rootDb: db, getActions: mockGetActions },
        { setting: "action", value: "nonexistent true" },
      );
      assert.ok(result.includes("not found"));
    },
    async function does_not_duplicate_on_double_enable(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-act-5', '["test_opt"]'::jsonb) ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => [
        { name: "test_opt", optIn: true },
      ];
      await action_fn(
        { chatId: "cs-act-5", rootDb: db, getActions: mockGetActions },
        { setting: "action", value: "test_opt true" },
      );
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'cs-act-5'`;
      const count = chat.enabled_actions.filter(/** @param {string} a */ (a) => a === "test_opt").length;
      assert.equal(count, 1);
    },
    async function shows_action_usage_when_missing_args(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-6') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-act-6", rootDb: db, getActions: async () => [] },
        { setting: "action", value: "just_one_arg" },
      );
      assert.ok(result.includes("Usage"));
    },
    async function gets_enabled_actions_list(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-act-7', '["track_purchases"]'::jsonb) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-act-7", rootDb: db },
        { setting: "action" },
      );
      assert.ok(result.includes("track_purchases"));
    },

    // ── model role settings (coding_model, smart_model, etc.) ──
    async function sets_coding_model(action_fn, db) {
      await withModelsCache([
        { id: "deepseek/coder", name: "Deepseek Coder", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-role-1", rootDb: db },
          { setting: "coding_model", value: "deepseek/coder" },
        );
        assert.ok(result.includes("deepseek/coder"));
        const { rows: [chat] } = await db.sql`SELECT model_roles FROM chats WHERE chat_id = 'cs-role-1'`;
        assert.equal(chat.model_roles.coding, "deepseek/coder");
      });
    },
    async function gets_coding_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-2') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET model_roles = '{"coding":"deepseek/coder"}'::jsonb WHERE chat_id = 'cs-role-2'`;
      const result = await action_fn(
        { chatId: "cs-role-2", rootDb: db },
        { setting: "coding_model" },
      );
      assert.ok(result.includes("deepseek/coder"));
    },
    async function gets_default_coding_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-3') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-role-3", rootDb: db },
        { setting: "coding_model" },
      );
      assert.ok(result.includes("not set") || result.includes("default"));
    },
    async function clears_coding_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-4') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET model_roles = '{"coding":"deepseek/coder"}'::jsonb WHERE chat_id = 'cs-role-4'`;
      const result = await action_fn(
        { chatId: "cs-role-4", rootDb: db },
        { setting: "coding_model", value: "" },
      );
      assert.ok(result.includes("cleared") || result.includes("reverted") || result.includes("default"));
      const { rows: [chat] } = await db.sql`SELECT model_roles FROM chats WHERE chat_id = 'cs-role-4'`;
      assert.equal(chat.model_roles.coding, undefined);
    },
    async function sets_image_generation_model(action_fn, db) {
      await withModelsCache([
        { id: "dalle-3", name: "DALL-E 3", context_length: 4096, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-5') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-role-5", rootDb: db },
          { setting: "image_generation_model", value: "dalle-3" },
        );
        assert.ok(result.includes("dalle-3"));
        const { rows: [chat] } = await db.sql`SELECT model_roles FROM chats WHERE chat_id = 'cs-role-5'`;
        assert.equal(chat.model_roles.image_generation, "dalle-3");
      });
    },
    async function rejects_invalid_role_model(action_fn, db) {
      await withModelsCache([], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-6') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-role-6", rootDb: db },
          { setting: "coding_model", value: "nonexistent/model" },
        );
        assert.ok(result.includes("not found") || result.includes("nvalid") || result.includes("error"), `Expected rejection, got: ${result}`);
      });
    },
    async function info_shows_role_overrides(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-7') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET model_roles = '{"coding":"deepseek/coder","fast":"gpt-4o-mini"}'::jsonb WHERE chat_id = 'cs-role-7'`;
      const result = await action_fn(
        { chatId: "cs-role-7", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("deepseek/coder"), "should include coding model override");
      assert.ok(result.includes("gpt-4o-mini"), "should include fast model override");
    },
  ],
  action_fn: async function ({ chatId, rootDb, senderIds, getActions, getIsAdmin }, { setting, value }) {
    if (!setting || !SETTINGS.includes(setting)) {
      return getInfo(rootDb, chatId, { senderIds });
    }

    if (value === undefined || value === null) {
      return getSetting(rootDb, chatId, setting);
    }

    const isAdmin = getIsAdmin ? await getIsAdmin() : true;
    if (!isAdmin) {
      return "Only admins can change settings.";
    }

    return setSetting(rootDb, chatId, setting, String(value), { senderIds, getActions });
  },
});
