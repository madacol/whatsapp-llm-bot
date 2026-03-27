import { existsSync, readdirSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import config from "../../../config.js";
import { validateModel, getModelModalities } from "../../../models-cache.js";
import { getChatOrThrow } from "../../../store.js";
import { ROLE_DEFINITIONS, resolveModel } from "../../../model-roles.js";
import { listHarnesses } from "#harnesses";

/**
 * Role names that use model_roles JSONB for per-chat overrides.
 * Excludes "chat" (has dedicated `model` column) and *_to_text roles
 * (use `media_to_text_models` JSONB).
 */
export const MODEL_ROLE_SETTINGS = Object.keys(ROLE_DEFINITIONS)
  .filter((r) => r !== "chat" && !r.endsWith("_to_text"))
  .map((r) => `${r}_model`);

export const SETTINGS = [
  "model",
  "system_prompt",
  "memory",
  "memory_threshold",
  "trigger",
  "image_to_text_model",
  "audio_to_text_model",
  "video_to_text_model",
  "media_to_text_model",
  ...MODEL_ROLE_SETTINGS,
  "enabled",
  "debug",
  "actions",
  "harness",
  "harness_cwd",
];

const RESPOND_ON_VALUES = ["any", "mention+reply", "mention"];
const CHAT_WORKSPACE_DEFAULT_LABEL = "chat workspace default";

/**
 * @typedef {{
 *   key: string;
 *   setting: string;
 *   label: string;
 *   description: string;
 *   examples: string[];
 *   aliases?: readonly string[];
 *   options?: readonly string[];
 *   resettable?: boolean;
 * }} ConfigKeyDefinition
 */

/**
 * @param {string} roleName
 * @returns {string}
 */
function roleSettingToFriendlyKey(roleName) {
  switch (roleName) {
    case "image_generation":
      return "image-model";
    case "embedding":
      return "embedding-model";
    case "video_generation":
      return "video-model";
    default:
      return `${roleName.replace(/_/g, "-")}-model`;
  }
}

/** @type {ConfigKeyDefinition[]} */
const BASE_CONFIG_KEYS = [
  {
    key: "enabled",
    setting: "enabled",
    label: "enabled",
    description: "Turns the bot on or off for this chat.",
    options: ["on", "off"],
    examples: ["!c enabled on", "!c enabled off"],
  },
  {
    key: "model",
    setting: "model",
    label: "model",
    description: "Chooses the main chat model for this chat.",
    examples: ["!c model gpt-5.4", "!c reset model"],
    resettable: true,
  },
  {
    key: "prompt",
    setting: "system_prompt",
    label: "prompt",
    description: "Sets the system prompt used to steer replies in this chat.",
    aliases: ["system_prompt"],
    examples: ["!c prompt Be concise and skeptical.", "!c reset prompt"],
    resettable: true,
  },
  {
    key: "trigger",
    setting: "trigger",
    label: "trigger",
    description: "Controls when the bot responds in the chat.",
    options: RESPOND_ON_VALUES,
    examples: ["!c trigger mention", "!c trigger mention+reply", "!c trigger any"],
  },
  {
    key: "memory",
    setting: "memory",
    label: "memory",
    description: "Turns long-term memory on or off for this chat.",
    options: ["on", "off"],
    examples: ["!c memory on", "!c memory off"],
  },
  {
    key: "threshold",
    setting: "memory_threshold",
    label: "threshold",
    description: "Sets the similarity threshold used when recalling memories.",
    aliases: ["memory_threshold"],
    examples: ["!c threshold 0.7", "!c reset threshold"],
    resettable: true,
  },
  {
    key: "debug",
    setting: "debug",
    label: "debug",
    description: "Shows extra internal debugging details in this chat.",
    options: ["on", "off"],
    examples: ["!c debug on", "!c debug off"],
  },
  {
    key: "harness",
    setting: "harness",
    label: "harness",
    description: "Chooses which harness runs the conversation.",
    examples: ["!c harness native", "!c harness codex", "!c reset harness"],
    resettable: true,
  },
  {
    key: "folder",
    setting: "harness_cwd",
    label: "folder",
    description: "Sets the working folder used by the coding harness.",
    aliases: ["harness_cwd"],
    examples: ["!c folder /home/mada/project", "!c reset folder"],
    resettable: true,
  },
  {
    key: "media-reader",
    setting: "media_to_text_model",
    label: "media-reader",
    description: "Sets the fallback model used to read image, audio, and video inputs.",
    aliases: ["media_to_text_model"],
    examples: ["!c media-reader openai/gpt-4.1", "!c reset media-reader"],
    resettable: true,
  },
  {
    key: "image-reader",
    setting: "image_to_text_model",
    label: "image-reader",
    description: "Sets the model used to read images in this chat.",
    aliases: ["image_to_text_model"],
    examples: ["!c image-reader openai/gpt-4.1", "!c reset image-reader"],
    resettable: true,
  },
  {
    key: "audio-reader",
    setting: "audio_to_text_model",
    label: "audio-reader",
    description: "Sets the model used to read audio in this chat.",
    aliases: ["audio_to_text_model"],
    examples: ["!c audio-reader openai/gpt-4.1", "!c reset audio-reader"],
    resettable: true,
  },
  {
    key: "video-reader",
    setting: "video_to_text_model",
    label: "video-reader",
    description: "Sets the model used to read videos in this chat.",
    aliases: ["video_to_text_model"],
    examples: ["!c video-reader openai/gpt-4.1", "!c reset video-reader"],
    resettable: true,
  },
  {
    key: "action",
    setting: "actions",
    label: "action",
    aliases: ["actions"],
    description: "Enables or disables one opt-in action for this chat.",
    examples: ["!c action searchWeb on", "!c action searchWeb off"],
  },
];

/** @type {ConfigKeyDefinition[]} */
const ROLE_CONFIG_KEYS = Object.keys(ROLE_DEFINITIONS)
  .filter((roleName) => !roleName.endsWith("_to_text") && roleName !== "chat")
  .map((roleName) => ({
    key: roleSettingToFriendlyKey(roleName),
    setting: `${roleName}_model`,
    label: roleSettingToFriendlyKey(roleName),
    description: ROLE_DEFINITIONS[roleName].description,
    aliases: [`${roleName}_model`, roleName],
    examples: [`!c ${roleSettingToFriendlyKey(roleName)} openai/gpt-4.1`, `!c reset ${roleSettingToFriendlyKey(roleName)}`],
    resettable: true,
  }));

/** @type {ConfigKeyDefinition[]} */
const CONFIG_KEY_DEFINITIONS = [...BASE_CONFIG_KEYS, ...ROLE_CONFIG_KEYS];

/** @type {ReadonlyMap<string, ConfigKeyDefinition>} */
const CONFIG_KEY_MAP = new Map(
  CONFIG_KEY_DEFINITIONS.flatMap((definition) => {
    const names = [definition.key, definition.setting, ...(definition.aliases ?? [])];
    return names.map((name) => [name.toLowerCase(), definition]);
  }),
);

export const CONFIG_KEYS = CONFIG_KEY_DEFINITIONS.map((definition) => definition.key);

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
export function isMaster(senderIds) {
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
 * @param {string} key
 * @returns {ConfigKeyDefinition | null}
 */
export function getConfigKeyDefinition(key) {
  return CONFIG_KEY_MAP.get(key.trim().toLowerCase()) ?? null;
}

/**
 * @param {import("../../../store.js").ChatRow} chat
 * @param {string} setting
 * @param {{ getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
async function formatCurrentValue(chat, setting, extra) {
  switch (setting) {
    case "model":
      return chat.model ?? `${resolveModel("chat")} (default)`;
    case "system_prompt":
      return chat.system_prompt ?? `${config.system_prompt} (default)`;
    case "memory":
      return chat.memory ? "on" : "off";
    case "memory_threshold":
      return String(chat.memory_threshold ?? config.memory_threshold);
    case "trigger":
      return chat.respond_on ?? "mention";
    case "enabled":
      return chat.is_enabled ? "on" : "off";
    case "debug":
      return chat.debug ? "on" : "off";
    case "harness":
      return chat.harness ?? "native";
    case "harness_cwd":
      return chat.harness_cwd ?? CHAT_WORKSPACE_DEFAULT_LABEL;
    case "actions":
      return formatOptInActions(chat.enabled_actions ?? [], extra.getActions);
    case "media_to_text_model":
      return chat.media_to_text_models?.general ?? "default";
    case "image_to_text_model":
      return chat.media_to_text_models?.image ?? "default";
    case "audio_to_text_model":
      return chat.media_to_text_models?.audio ?? "default";
    case "video_to_text_model":
      return chat.media_to_text_models?.video ?? "default";
    default:
      if (MODEL_ROLE_SETTINGS.includes(setting)) {
        const roleName = setting.replace(/_model$/, "");
        return chat.model_roles?.[roleName] ?? "default";
      }
      return "unknown";
  }
}

/**
 * @param {string} setting
 * @returns {string}
 */
function formatDefaultValue(setting) {
  switch (setting) {
    case "model":
      return resolveModel("chat");
    case "system_prompt":
      return config.system_prompt;
    case "memory":
      return "off";
    case "memory_threshold":
      return String(config.memory_threshold);
    case "trigger":
      return "mention";
    case "enabled":
      return "off";
    case "debug":
      return "off";
    case "harness":
      return "native";
    case "harness_cwd":
      return CHAT_WORKSPACE_DEFAULT_LABEL;
    case "actions":
      return "all opt-in actions off";
    case "media_to_text_model":
    case "image_to_text_model":
    case "audio_to_text_model":
    case "video_to_text_model":
      return "default";
    default:
      if (MODEL_ROLE_SETTINGS.includes(setting)) {
        const roleName = setting.replace(/_model$/, "");
        return resolveModel(roleName);
      }
      return "default";
  }
}

/**
 * @param {ConfigKeyDefinition} definition
 * @returns {string[]}
 */
function getDefinitionOptions(definition) {
  if (definition.setting === "harness") {
    return listHarnesses();
  }
  return definition.options ? [...definition.options] : [];
}

/**
 * Show a full summary of all chat settings.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {{ senderIds?: string[], getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
export async function getChatSettingsInfo(rootDb, chatId, extra) {
  const chat = await getChatOrThrow(rootDb, chatId);
  const senderIds = extra.senderIds ?? [];
  const enabledActions = chat.enabled_actions ?? [];
  const optInStr = await formatOptInActions(enabledActions, extra.getActions);
  const modelRoles = chat.model_roles ?? {};
  const roleOverrides = ROLE_CONFIG_KEYS
    .map((definition) => {
      const roleName = definition.setting.replace(/_model$/, "");
      return `${definition.key}: ${modelRoles[roleName] ?? "default"}`;
    })
    .join(", ");

  const lines = [
    `*Chat:* ${chatId}`,
    `*Sender:* ${senderIds.join(", ")}`,
    "Use `!c <key>` to inspect a setting or `!c reset <key>` to revert a resettable one.",
    `*enabled:* ${chat.is_enabled ? "on" : "off"}`,
    `*model:* ${chat.model ?? `${resolveModel("chat")} (default)`}`,
    `*prompt:* ${chat.system_prompt ? "custom" : "default"}`,
    `*trigger:* ${chat.respond_on ?? "mention"}`,
    `*memory:* ${chat.memory ? "on" : "off"}`,
    `*threshold:* ${chat.memory_threshold ?? config.memory_threshold}`,
    `*debug:* ${chat.debug ? "on" : "off"}`,
    `*harness:* ${chat.harness ?? "native"}`,
    `*folder:* ${chat.harness_cwd ?? CHAT_WORKSPACE_DEFAULT_LABEL}`,
    `*readers:* media=${chat.media_to_text_models?.general ?? "default"}, image=${chat.media_to_text_models?.image ?? "default"}, audio=${chat.media_to_text_models?.audio ?? "default"}, video=${chat.media_to_text_models?.video ?? "default"}`,
    `*model overrides:* ${roleOverrides}`,
    `*actions:* ${optInStr}`,
  ];

  return lines.join("\n");
}

/** @type {SelectOption[]} */
const BOOL_OPTIONS = [
  { id: "on", label: "on" },
  { id: "off", label: "off" },
];

/**
 * Return selectable options and the current value id for settings with fewer
 * than 5 fixed choices. Returns `null` if the setting is free-text.
 *
 * @param {string} setting
 * @param {import("../../../store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentId: string } | null}
 */
export function getSelectableOptions(setting, chat) {
  switch (setting) {
    case "trigger":
      return {
        options: RESPOND_ON_VALUES.map((v) => ({ id: v, label: v })),
        currentId: chat.respond_on ?? "mention",
      };
    case "memory":
      return { options: BOOL_OPTIONS, currentId: chat.memory ? "on" : "off" };
    case "enabled":
      return { options: BOOL_OPTIONS, currentId: chat.is_enabled ? "on" : "off" };
    case "debug":
      return { options: BOOL_OPTIONS, currentId: chat.debug ? "on" : "off" };
    case "harness": {
      const available = listHarnesses();
      if (available.length >= 5) return null;
      return {
        options: available.map((h) => ({ id: h, label: h })),
        currentId: chat.harness ?? "native",
      };
    }
    default:
      return null;
  }
}

/**
 * Show a detailed help page for one user-facing config key.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} key
 * @param {{ getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
export async function describeConfigKey(rootDb, chatId, key, extra) {
  const definition = getConfigKeyDefinition(key);
  if (!definition) {
    return `Unknown config key \`${key}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
  }

  const chat = await getChatOrThrow(rootDb, chatId);
  const current = await formatCurrentValue(chat, definition.setting, extra);
  const options = getDefinitionOptions(definition);
  const lines = [
    definition.label,
    `Current: ${current}`,
    `Default: ${formatDefaultValue(definition.setting)}`,
    `What it does: ${definition.description}`,
  ];

  if (options.length > 0) {
    lines.push(`Options: ${options.join(", ")}`);
  }

  lines.push("Examples:");
  lines.push(...definition.examples);

  return lines.join("\n");
}

/**
 * Set a config value by its user-facing key.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} key
 * @param {string} value
 * @param {{ senderIds?: string[], getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
export async function setConfigValue(rootDb, chatId, key, value, extra) {
  const definition = getConfigKeyDefinition(key);
  if (!definition) {
    return `Unknown config key \`${key}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
  }
  return setChatSetting(rootDb, chatId, definition.setting, value, extra);
}

/**
 * Reset a config value by removing the chat override.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} key
 * @param {{ senderIds?: string[], getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
export async function resetConfigValue(rootDb, chatId, key, extra) {
  const definition = getConfigKeyDefinition(key);
  if (!definition) {
    return `Unknown config key \`${key}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
  }
  if (!definition.resettable) {
    return `\`${definition.label}\` cannot be reset. Set an explicit value instead.`;
  }
  return setChatSetting(rootDb, chatId, definition.setting, "", extra);
}

/**
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} setting
 * @param {{ getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
export async function getChatSetting(rootDb, chatId, setting, extra) {
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
    case "trigger":
      return `Trigger: ${chat.respond_on ?? "mention"}`;
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
    case "debug":
      return `Debug: ${chat.debug ? "on" : "off"}`;
    case "actions": {
      const enabledActions = chat.enabled_actions ?? [];
      const optInStr = await formatOptInActions(enabledActions, extra.getActions);
      return `Actions: ${optInStr}`;
    }
    case "harness": {
      const available = listHarnesses();
      return `Harness: ${chat.harness ?? "native"}\nAvailable: ${available.join(", ")}`;
    }
    case "harness_cwd":
      return `Harness folder: ${chat.harness_cwd ?? `not set (${CHAT_WORKSPACE_DEFAULT_LABEL})`}`;
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
export async function setChatSetting(rootDb, chatId, setting, value, extra) {
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
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await rootDb.sql`UPDATE chats SET memory_threshold = NULL WHERE chat_id = ${chatId}`;
        return `Memory threshold reset to default (${config.memory_threshold}).`;
      }
      const threshold = parseFloat(trimmed);
      if (isNaN(threshold) || threshold < 0 || threshold > 1) {
        throw new Error("Threshold must be a number between 0 and 1.");
      }
      await rootDb.sql`UPDATE chats SET memory_threshold = ${threshold} WHERE chat_id = ${chatId}`;
      return `Memory similarity threshold set to ${threshold} for this chat.`;
    }

    case "trigger": {
      const trimmed = value.trim().toLowerCase();
      if (!RESPOND_ON_VALUES.includes(trimmed)) {
        return `Invalid value. Must be one of: ${RESPOND_ON_VALUES.join(", ")}`;
      }
      await rootDb.sql`UPDATE chats SET respond_on = ${trimmed} WHERE chat_id = ${chatId}`;
      return `Trigger: ${trimmed}`;
    }

    case "image_to_text_model":
    case "audio_to_text_model":
    case "video_to_text_model": {
      const type = /** @type {"image"|"audio"|"video"} */ (setting.replace("_to_text_model", ""));
      const trimmed = value.trim();

      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels[type];
        await rootDb.sql`
          UPDATE chats
          SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return `${type}-reader reset to default.`;
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes(type)) {
        return `Model \`${trimmed}\` does not support \`${type}\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

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

      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.general;
        await rootDb.sql`
          UPDATE chats
          SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return "media-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.some((m) => ["image", "audio", "video"].includes(m))) {
        return `Model \`${trimmed}\` does not support any media input (image, audio, or video).`;
      }

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
      const enabled = toBool(value);
      await rootDb.sql`UPDATE chats SET debug = ${enabled} WHERE chat_id = ${chatId}`;
      return `Debug ${enabled ? "on" : "off"}.`;
    }

    case "harness": {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await rootDb.sql`UPDATE chats SET harness = NULL WHERE chat_id = ${chatId}`;
        return "Harness reset to `native`.";
      }
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

      if (cwdValue && !existsSync(cwdValue)) {
        const parent = dirname(resolve(cwdValue));
        const target = basename(cwdValue);
        /** @type {string[]} */
        let suggestions = [];
        if (existsSync(parent)) {
          try {
            suggestions = readdirSync(parent, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => `${parent}/${d.name}`)
              .filter((p) => p !== cwdValue)
              .sort((a, b) => {
                const aName = basename(a).toLowerCase();
                const bName = basename(b).toLowerCase();
                const t = target.toLowerCase();
                const aMatch = aName.includes(t) || t.includes(aName) ? 1 : 0;
                const bMatch = bName.includes(t) || t.includes(bName) ? 1 : 0;
                return bMatch - aMatch;
              })
              .slice(0, 5);
          } catch {
          }
        }
        let msg = `Path \`${cwdValue}\` does not exist.`;
        if (suggestions.length > 0) {
          msg += `\n\nDid you mean one of these?\n${suggestions.map((s) => `• \`${s}\``).join("\n")}`;
        } else {
          msg += `\nThe parent directory \`${parent}\` ${existsSync(parent) ? "exists but is empty" : "does not exist either"}.`;
        }
        return msg;
      }

      await rootDb.sql`UPDATE chats SET harness_cwd = ${cwdValue} WHERE chat_id = ${chatId}`;
      return cwdValue
        ? `Harness folder set to \`${cwdValue}\``
        : `Harness folder cleared; using ${CHAT_WORKSPACE_DEFAULT_LABEL}.`;
    }

    case "actions": {
      const parts = value.trim().split(/\s+/);
      if (parts.length < 2) {
        return "Usage: !c action <action_name> <on|off>";
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
        updated = currentActions.filter((a) => a !== actionName);
      }

      await rootDb.sql`UPDATE chats SET enabled_actions = ${JSON.stringify(updated)}::jsonb WHERE chat_id = ${chatId}`;
      return `Action \`${actionName}\` ${actionEnabled ? "enabled" : "disabled"} for this chat.`;
    }

    default: {
      if (MODEL_ROLE_SETTINGS.includes(setting)) {
        const roleName = setting.replace(/_model$/, "");
        const trimmed = value.trim();

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
