import config from "../../../config.js";
import { validateModel, getModelModalities } from "../../../models-cache.js";
import { getChatOrThrow } from "../../../store.js";
import { ROLE_DEFINITIONS, resolveModel } from "../../../model-roles.js";
import { listHarnesses } from "../../../harnesses/index.js";

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
  "harness",
  "harness_cwd",
];

const RESPOND_ON_VALUES = ["any", "mention+reply", "mention"];

/**
 * Parse a string-or-boolean to a boolean.
 * @param {unknown} raw
 * @returns {boolean}
 */
const TRUTHY = new Set(["true", "on", "yes", "1", "enabled"]);
const FALSY = new Set(["false", "off", "no", "0", "disabled"]);

function toBool(/** @type {unknown} */ raw) {
  if (typeof raw === "boolean") return raw;
  const s = String(raw).toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  throw new Error(
    `Invalid boolean value "${raw}". Must be one of: on, off, true, false, yes, no, enabled, disabled.`,
  );
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
 * Format the opt-in actions line showing enabled/available actions.
 * @param {string[]} enabledActions
 * @param {(() => Promise<Action[]>) | undefined} getActions
 * @returns {Promise<string>}
 */
async function formatOptInActions(enabledActions, getActions) {
  if (!getActions) {
    return enabledActions.length > 0 ? enabledActions.join(", ") : "none";
  }
  const allActions = await getActions();
  const optInActions = allActions.filter((a) => a.optIn);
  if (optInActions.length === 0) return "none available";
  return optInActions
    .map((a) => {
      const on = enabledActions.includes(a.name);
      return `${a.name} (${on ? "on" : "off"})`;
    })
    .join(", ");
}

/**
 * Show a full summary of all chat settings.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {{ senderIds?: string[], getActions?: () => Promise<Action[]> }} extra
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
  const optInStr = await formatOptInActions(enabledActions, extra.getActions);

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
    `*Harness:* ${chat.harness ?? "native"}`,
    ...(chat.harness_cwd ? [`*Harness CWD:* ${chat.harness_cwd}`] : []),
  ];

  return lines.join("\n");
}

/**
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} setting
 * @param {{ getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
async function getSetting(rootDb, chatId, setting, extra) {
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
      const optInStr = await formatOptInActions(enabledActions, extra.getActions);
      return `Opt-in actions: ${optInStr}`;
    }
    case "harness": {
      const available = listHarnesses();
      return `Harness: ${chat.harness ?? "native"}\nAvailable: ${available.join(", ")}`;
    }
    case "harness_cwd":
      return `Harness CWD: ${chat.harness_cwd ?? "not set (uses project root)"}`;
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

      if (input === "off" || input === "false" || input === "no") {
        await rootDb.sql`UPDATE chats SET debug_until = NULL WHERE chat_id = ${chatId}`;
        return "Debug off.";
      }

      const mins = input === "" || input === "on" || input === "true" || input === "yes" ? 10 : Number(input);
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

    case "harness": {
      const trimmed = value.trim();
      const available = listHarnesses();
      if (!available.includes(trimmed)) {
        return `Unknown harness \`${trimmed}\`. Available: ${available.join(", ")}`;
      }
      const harnessValue = trimmed === "native" ? null : trimmed;
      await rootDb.sql`UPDATE chats SET harness = ${harnessValue} WHERE chat_id = ${chatId}`;
      return `Harness set to \`${trimmed}\``;
    }

    case "harness_cwd": {
      const trimmed = value.trim();
      const cwdValue = trimmed.length === 0 ? null : trimmed;
      await rootDb.sql`UPDATE chats SET harness_cwd = ${cwdValue} WHERE chat_id = ${chatId}`;
      return cwdValue
        ? `Harness CWD set to \`${cwdValue}\``
        : "Harness CWD cleared (will use project root).";
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
  formatToolCall: ({ setting, value }) =>
    value != null ? `Setting ${setting} = ${value}` : `Getting ${setting}`,
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb, senderIds, getActions, getIsAdmin }, { setting, value }) {
    if (!setting || !SETTINGS.includes(setting)) {
      return getInfo(rootDb, chatId, { senderIds, getActions });
    }

    if (value === undefined || value === null) {
      return getSetting(rootDb, chatId, setting, { getActions });
    }

    const isAdmin = getIsAdmin ? await getIsAdmin() : true;
    if (!isAdmin) {
      return "Only admins can change settings.";
    }

    return setSetting(rootDb, chatId, setting, String(value), { senderIds, getActions });
  },
});
