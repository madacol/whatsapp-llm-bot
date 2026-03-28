import { existsSync, readdirSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import config from "../../../config.js";
import { validateModel, getModelModalities } from "../../../models-cache.js";
import { getChatOrThrow } from "../../../store.js";
import { ROLE_DEFINITIONS, resolveModel } from "../../../model-roles.js";
import { listHarnesses } from "#harnesses";
import {
  buildOutputVisibilityOverrides,
  OUTPUT_VISIBILITY_FLAGS,
  formatOutputVisibility,
  formatOutputVisibilityDefault,
  getEnabledOutputVisibilityKeys,
  isOutputVisibilityKey,
  DEFAULT_OUTPUT_VISIBILITY,
} from "../../../chat-output-visibility.js";

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
  "output_visibility",
];

const RESPOND_ON_VALUES = ["any", "mention+reply", "mention"];
const CHAT_WORKSPACE_DEFAULT_LABEL = "chat workspace default";
const BOOL_VALUE_IDS = ["on", "off"];
const SHOW_NONE_OPTION_ID = "none";

/**
 * @typedef {import("../../../chat-output-visibility.js").OutputVisibilityFlagDefinition} ConfigFlagDefinition
 */

/**
 * @typedef {{
 *   currentId: (chat: import("../../../store.js").ChatRow) => string;
 *   options?: readonly string[];
 *   getOptions?: () => readonly string[];
 * }} ConfigPickerDefinition
 */

/**
 * @typedef {{
 *   currentIds: (chat: import("../../../store.js").ChatRow) => string[];
 *   options?: readonly string[];
 *   getOptions?: () => readonly string[];
 * }} ConfigMultiPickerDefinition
 */

/**
 * @typedef {{
 *   rootDb: PGlite;
 *   chatId: string;
 *   chat: import("../../../store.js").ChatRow;
 *   value: string;
 *   extra: { senderIds?: string[], getActions?: () => Promise<Action[]> };
 * }} ConfigSetContext
 */

/**
 * @typedef {(chat: import("../../../store.js").ChatRow, extra: { getActions?: () => Promise<Action[]> }) => string | Promise<string>} ConfigCurrentFormatter
 */

/**
 * @typedef {() => string} ConfigDefaultFormatter
 */

/**
 * @typedef {(context: ConfigSetContext) => Promise<string>} ConfigSetter
 */

/**
 * @typedef {{
 *   key: string;
  *   setting: string;
 *   label: string;
 *   description: string;
 *   examples: string[];
 *   aliases?: readonly string[];
 *   picker?: ConfigPickerDefinition;
 *   multiPicker?: ConfigMultiPickerDefinition;
 *   flags?: readonly ConfigFlagDefinition[];
 *   resettable?: boolean;
 *   formatCurrent: ConfigCurrentFormatter;
 *   formatDefault: ConfigDefaultFormatter;
 *   setValue: ConfigSetter;
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

/**
 * @param {boolean} value
 * @returns {string}
 */
function formatBoolValue(value) {
  return value ? "on" : "off";
}

/**
 * @param {string} label
 * @returns {string}
 */
function formatSettingTitle(label) {
  return label
    .replace(/-/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * @param {string[]} selectedIds
 * @returns {selectedIds is import("../../../chat-output-visibility.js").OutputVisibilityKey[]}
 */
function areOutputVisibilityKeys(selectedIds) {
  return selectedIds.every((id) => isOutputVisibilityKey(id));
}

/**
 * @param {Omit<ConfigKeyDefinition, "formatCurrent" | "formatDefault" | "setValue"> & {
 *   formatCurrent: ConfigCurrentFormatter;
 *   formatDefault: ConfigDefaultFormatter;
 *   setValue: ConfigSetter;
 * }} definition
 * @returns {ConfigKeyDefinition}
 */
function createConfigKeyDefinition(definition) {
  return definition;
}

/** @type {ConfigKeyDefinition[]} */
const BASE_CONFIG_KEYS = [
  createConfigKeyDefinition({
    key: "enabled",
    setting: "enabled",
    label: "enabled",
    description: "Turns the bot on or off for this chat.",
    examples: ["!c enabled on", "!c enabled off"],
    picker: {
      options: BOOL_VALUE_IDS,
      currentId: (chat) => chat.is_enabled ? "on" : "off",
    },
    formatCurrent: (chat) => formatBoolValue(chat.is_enabled),
    formatDefault: () => "off",
    setValue: async ({ rootDb, chatId, value, extra }) => {
      const senderIds = extra.senderIds ?? [];
      if (!isMaster(senderIds)) {
        return "Only master users can change the enabled setting.";
      }
      const enabled = toBool(value);
      await rootDb.sql`UPDATE chats SET is_enabled = ${enabled} WHERE chat_id = ${chatId}`;
      return `Bot ${enabled ? "enabled" : "disabled"}.`;
    },
  }),
  createConfigKeyDefinition({
    key: "model",
    setting: "model",
    label: "model",
    description: "Chooses the main chat model for this chat.",
    examples: ["!c model gpt-5.4", "!c reset model"],
    resettable: true,
    formatCurrent: (chat) => chat.model ?? `${resolveModel("chat")} (default)`,
    formatDefault: () => resolveModel("chat"),
    setValue: async ({ rootDb, chatId, value }) => {
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
    },
  }),
  createConfigKeyDefinition({
    key: "prompt",
    setting: "system_prompt",
    label: "prompt",
    description: "Sets the system prompt used to steer replies in this chat.",
    aliases: ["system_prompt"],
    examples: ["!c prompt Be concise and skeptical.", "!c reset prompt"],
    resettable: true,
    formatCurrent: (chat) => chat.system_prompt ?? `${config.system_prompt} (default)`,
    formatDefault: () => config.system_prompt,
    setValue: async ({ rootDb, chatId, value }) => {
      const trimmed = value.trim();
      const newPrompt = trimmed.length === 0 ? null : trimmed;
      await rootDb.sql`UPDATE chats SET system_prompt = ${newPrompt} WHERE chat_id = ${chatId}`;
      return newPrompt === null
        ? "Prompt cleared, using default."
        : `Prompt set to: ${trimmed}`;
    },
  }),
  createConfigKeyDefinition({
    key: "trigger",
    setting: "trigger",
    label: "trigger",
    description: "Controls when the bot responds in the chat.",
    examples: ["!c trigger mention", "!c trigger mention+reply", "!c trigger any"],
    picker: {
      options: RESPOND_ON_VALUES,
      currentId: (chat) => chat.respond_on ?? "mention",
    },
    formatCurrent: (chat) => chat.respond_on ?? "mention",
    formatDefault: () => "mention",
    setValue: async ({ rootDb, chatId, value }) => {
      const trimmed = value.trim().toLowerCase();
      if (!RESPOND_ON_VALUES.includes(trimmed)) {
        return `Invalid value. Must be one of: ${RESPOND_ON_VALUES.join(", ")}`;
      }
      await rootDb.sql`UPDATE chats SET respond_on = ${trimmed} WHERE chat_id = ${chatId}`;
      return `Trigger: ${trimmed}`;
    },
  }),
  createConfigKeyDefinition({
    key: "memory",
    setting: "memory",
    label: "memory",
    description: "Turns long-term memory on or off for this chat.",
    examples: ["!c memory on", "!c memory off"],
    picker: {
      options: BOOL_VALUE_IDS,
      currentId: (chat) => chat.memory ? "on" : "off",
    },
    formatCurrent: (chat) => formatBoolValue(chat.memory),
    formatDefault: () => "off",
    setValue: async ({ rootDb, chatId, value }) => {
      const enabled = toBool(value);
      await rootDb.sql`UPDATE chats SET memory = ${enabled} WHERE chat_id = ${chatId}`;
      return `Long-term memory ${enabled ? "enabled" : "disabled"} for this chat.`;
    },
  }),
  createConfigKeyDefinition({
    key: "threshold",
    setting: "memory_threshold",
    label: "threshold",
    description: "Sets the similarity threshold used when recalling memories.",
    aliases: ["memory_threshold"],
    examples: ["!c threshold 0.7", "!c reset threshold"],
    resettable: true,
    formatCurrent: (chat) => String(chat.memory_threshold ?? config.memory_threshold),
    formatDefault: () => String(config.memory_threshold),
    setValue: async ({ rootDb, chatId, value }) => {
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
    },
  }),
  createConfigKeyDefinition({
    key: "debug",
    setting: "debug",
    label: "debug",
    description: "Shows extra internal debugging details in this chat.",
    examples: ["!c debug on", "!c debug off"],
    picker: {
      options: BOOL_VALUE_IDS,
      currentId: (chat) => chat.debug ? "on" : "off",
    },
    formatCurrent: (chat) => formatBoolValue(chat.debug),
    formatDefault: () => "off",
    setValue: async ({ rootDb, chatId, value }) => {
      const enabled = toBool(value);
      await rootDb.sql`UPDATE chats SET debug = ${enabled} WHERE chat_id = ${chatId}`;
      return `Debug ${enabled ? "on" : "off"}.`;
    },
  }),
  createConfigKeyDefinition({
    key: "harness",
    setting: "harness",
    label: "harness",
    description: "Chooses which harness runs the conversation.",
    examples: ["!c harness native", "!c harness codex", "!c reset harness"],
    picker: {
      getOptions: () => listHarnesses(),
      currentId: (chat) => chat.harness ?? "native",
    },
    resettable: true,
    formatCurrent: (chat) => chat.harness ?? "native",
    formatDefault: () => "native",
    setValue: async ({ rootDb, chatId, value }) => {
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
    },
  }),
  createConfigKeyDefinition({
    key: "show",
    setting: "output_visibility",
    label: "show",
    description: "Controls which extra agent progress outputs are shown in chat.",
    aliases: ["output_visibility", "output-visibility"],
    examples: ["!c show", "!c reset show"],
    multiPicker: {
      options: [...OUTPUT_VISIBILITY_FLAGS.map((flag) => flag.key), SHOW_NONE_OPTION_ID],
      currentIds: (chat) => {
        const enabled = getEnabledOutputVisibilityKeys(chat.output_visibility);
        return enabled.length > 0 ? enabled : [SHOW_NONE_OPTION_ID];
      },
    },
    flags: OUTPUT_VISIBILITY_FLAGS,
    resettable: true,
    formatCurrent: (chat) => formatOutputVisibility(chat.output_visibility),
    formatDefault: () => formatOutputVisibilityDefault(),
    setValue: async ({ rootDb, chatId, value }) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await rootDb.sql`UPDATE chats SET output_visibility = '{}'::jsonb WHERE chat_id = ${chatId}`;
        return `Show reset to defaults (${formatOutputVisibilityDefault()}).`;
      }

      const selectedIds = [...new Set(trimmed.split(/\s+/).filter((part) => part.length > 0))];
      if (selectedIds.includes(SHOW_NONE_OPTION_ID)) {
        if (selectedIds.length > 1) {
          return "Choose `none` by itself to hide all extra outputs.";
        }
        const nextVisibility = buildOutputVisibilityOverrides([]);
        await rootDb.sql`
          UPDATE chats
          SET output_visibility = ${JSON.stringify(nextVisibility)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return `Show set to ${formatOutputVisibility(nextVisibility)}.`;
      }
      if (!areOutputVisibilityKeys(selectedIds)) {
        return "Use `!c show` to pick visible outputs, or `!c reset show` to restore defaults.";
      }
      const nextVisibility = buildOutputVisibilityOverrides(selectedIds);
      await rootDb.sql`
        UPDATE chats
        SET output_visibility = ${JSON.stringify(nextVisibility)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      const matchesDefault = Object.keys(nextVisibility).length === 0;
      if (matchesDefault) {
        return `Show set to ${formatOutputVisibility(DEFAULT_OUTPUT_VISIBILITY)}.`;
      }
      return `Show set to ${formatOutputVisibility(nextVisibility)}.`;
    },
  }),
  createConfigKeyDefinition({
    key: "folder",
    setting: "harness_cwd",
    label: "folder",
    description: "Sets the working folder used by the coding harness.",
    aliases: ["harness_cwd"],
    examples: ["!c folder /home/mada/project", "!c reset folder"],
    resettable: true,
    formatCurrent: (chat) => chat.harness_cwd ?? CHAT_WORKSPACE_DEFAULT_LABEL,
    formatDefault: () => CHAT_WORKSPACE_DEFAULT_LABEL,
    setValue: async ({ rootDb, chatId, value }) => {
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
    },
  }),
  createConfigKeyDefinition({
    key: "media-reader",
    setting: "media_to_text_model",
    label: "media-reader",
    description: "Sets the fallback model used to read image, audio, and video inputs.",
    aliases: ["media_to_text_model"],
    examples: ["!c media-reader openai/gpt-4.1", "!c reset media-reader"],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.general ?? "default",
    formatDefault: () => "default",
    setValue: async ({ rootDb, chatId, chat, value }) => {
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
    },
  }),
  createConfigKeyDefinition({
    key: "image-reader",
    setting: "image_to_text_model",
    label: "image-reader",
    description: "Sets the model used to read images in this chat.",
    aliases: ["image_to_text_model"],
    examples: ["!c image-reader openai/gpt-4.1", "!c reset image-reader"],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.image ?? "default",
    formatDefault: () => "default",
    setValue: async ({ rootDb, chatId, chat, value }) => {
      const trimmed = value.trim();
      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.image;
        await rootDb.sql`
          UPDATE chats
          SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return "image-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes("image")) {
        return `Model \`${trimmed}\` does not support \`image\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      currentModels.image = trimmed;
      await rootDb.sql`
        UPDATE chats
        SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      return `image-to-text model set to \`${trimmed}\``;
    },
  }),
  createConfigKeyDefinition({
    key: "audio-reader",
    setting: "audio_to_text_model",
    label: "audio-reader",
    description: "Sets the model used to read audio in this chat.",
    aliases: ["audio_to_text_model"],
    examples: ["!c audio-reader openai/gpt-4.1", "!c reset audio-reader"],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.audio ?? "default",
    formatDefault: () => "default",
    setValue: async ({ rootDb, chatId, chat, value }) => {
      const trimmed = value.trim();
      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.audio;
        await rootDb.sql`
          UPDATE chats
          SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return "audio-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes("audio")) {
        return `Model \`${trimmed}\` does not support \`audio\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      currentModels.audio = trimmed;
      await rootDb.sql`
        UPDATE chats
        SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      return `audio-to-text model set to \`${trimmed}\``;
    },
  }),
  createConfigKeyDefinition({
    key: "video-reader",
    setting: "video_to_text_model",
    label: "video-reader",
    description: "Sets the model used to read videos in this chat.",
    aliases: ["video_to_text_model"],
    examples: ["!c video-reader openai/gpt-4.1", "!c reset video-reader"],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.video ?? "default",
    formatDefault: () => "default",
    setValue: async ({ rootDb, chatId, chat, value }) => {
      const trimmed = value.trim();
      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.video;
        await rootDb.sql`
          UPDATE chats
          SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return "video-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes("video")) {
        return `Model \`${trimmed}\` does not support \`video\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      currentModels.video = trimmed;
      await rootDb.sql`
        UPDATE chats
        SET media_to_text_models = ${JSON.stringify(currentModels)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      return `video-to-text model set to \`${trimmed}\``;
    },
  }),
  createConfigKeyDefinition({
    key: "action",
    setting: "actions",
    label: "action",
    aliases: ["actions"],
    description: "Enables or disables one opt-in action for this chat.",
    examples: ["!c action searchWeb on", "!c action searchWeb off"],
    formatCurrent: async (chat, extra) => formatOptInActions(chat.enabled_actions ?? [], extra.getActions),
    formatDefault: () => "all opt-in actions off",
    setValue: async ({ rootDb, chatId, value, extra }) => {
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
    },
  }),
];

/** @type {ConfigKeyDefinition[]} */
const ROLE_CONFIG_KEYS = Object.keys(ROLE_DEFINITIONS)
  .filter((roleName) => !roleName.endsWith("_to_text") && roleName !== "chat")
  .map((roleName) => createConfigKeyDefinition({
    key: roleSettingToFriendlyKey(roleName),
    setting: `${roleName}_model`,
    label: roleSettingToFriendlyKey(roleName),
    description: ROLE_DEFINITIONS[roleName].description,
    aliases: [`${roleName}_model`, roleName],
    examples: [`!c ${roleSettingToFriendlyKey(roleName)} openai/gpt-4.1`, `!c reset ${roleSettingToFriendlyKey(roleName)}`],
    resettable: true,
    formatCurrent: (chat) => chat.model_roles?.[roleName] ?? "default",
    formatDefault: () => resolveModel(roleName),
    setValue: async ({ rootDb, chatId, chat, value }) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        const currentRoles = { ...(chat.model_roles ?? {}) };
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

      const currentRoles = { ...(chat.model_roles ?? {}) };
      currentRoles[roleName] = trimmed;
      await rootDb.sql`
        UPDATE chats
        SET model_roles = ${JSON.stringify(currentRoles)}::jsonb
        WHERE chat_id = ${chatId}
      `;
      return `${roleName} model set to \`${trimmed}\``;
    },
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

/** @type {ReadonlyMap<string, ConfigKeyDefinition>} */
const CONFIG_SETTING_MAP = new Map(
  CONFIG_KEY_DEFINITIONS.map((definition) => [definition.setting, definition]),
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
 * @param {ConfigKeyDefinition} definition
 * @param {{ getActions?: () => Promise<Action[]> }} extra
 * @returns {Promise<string>}
 */
async function formatCurrentValue(chat, definition, extra) {
  return definition.formatCurrent(chat, extra);
}

/**
 * @param {ConfigKeyDefinition} definition
 * @returns {string}
 */
function formatDefaultValue(definition) {
  return definition.formatDefault();
}

/**
 * @param {ConfigKeyDefinition} definition
 * @returns {string[]}
 */
function getDefinitionOptions(definition) {
  if (definition.picker?.options) {
    return [...definition.picker.options];
  }
  if (definition.picker?.getOptions) {
    return [...definition.picker.getOptions()];
  }
  return [];
}

/**
 * @param {ConfigKeyDefinition} definition
 * @returns {string[]}
 */
function getDefinitionMultiOptions(definition) {
  if (definition.multiPicker?.options) {
    return [...definition.multiPicker.options];
  }
  if (definition.multiPicker?.getOptions) {
    return [...definition.multiPicker.getOptions()];
  }
  return [];
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
    "Config",
    `- Chat: ${chatId}`,
    `- Sender: ${senderIds.join(", ")}`,
    "",
    "Core",
    `- enabled: ${chat.is_enabled ? "on" : "off"}`,
    `- model: ${chat.model ?? `${resolveModel("chat")} (default)`}`,
    `- prompt: ${chat.system_prompt ? "custom" : "default"}`,
    `- trigger: ${chat.respond_on ?? "mention"}`,
    `- memory: ${chat.memory ? "on" : "off"}`,
    `- threshold: ${chat.memory_threshold ?? config.memory_threshold}`,
    `- debug: ${chat.debug ? "on" : "off"}`,
    `- show: ${formatOutputVisibility(chat.output_visibility)}`,
    "",
    "Harness",
    `- harness: ${chat.harness ?? "native"}`,
    `- folder: ${chat.harness_cwd ?? CHAT_WORKSPACE_DEFAULT_LABEL}`,
    "",
    "Models",
    `- readers: media=${chat.media_to_text_models?.general ?? "default"}, image=${chat.media_to_text_models?.image ?? "default"}, audio=${chat.media_to_text_models?.audio ?? "default"}, video=${chat.media_to_text_models?.video ?? "default"}`,
    `- overrides: ${roleOverrides}`,
    "",
    "Actions",
    `- opt-in actions: ${optInStr}`,
    "",
    "Use",
    "- `!c <key>` to inspect a setting",
    "- `!c help <key>` for the full description and examples",
    "- `!c reset <key>` to revert a resettable setting",
  ];

  return lines.join("\n");
}

/**
 * Return selectable options and the current value id for settings with fewer
 * than 5 fixed choices. Returns `null` if the setting is free-text.
 *
 * @param {string | ConfigKeyDefinition} config
 * @param {import("../../../store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentId: string } | null}
 */
export function getSelectableOptions(config, chat) {
  const definition = typeof config === "string" ? getConfigKeyDefinition(config) : config;
  if (!definition?.picker) {
    return null;
  }

  const optionIds = getDefinitionOptions(definition);
  if (optionIds.length === 0 || optionIds.length >= 5) {
    return null;
  }

  return {
    options: optionIds.map((optionId) => ({ id: optionId, label: optionId })),
    currentId: definition.picker.currentId(chat),
  };
}

/**
 * Return multi-selectable options for settings that expose semantic sets of
 * enabled values. Returns `null` if the setting is not multi-selectable.
 *
 * @param {string | ConfigKeyDefinition} config
 * @param {import("../../../store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentIds: string[] } | null}
 */
export function getMultiSelectableOptions(config, chat) {
  const definition = typeof config === "string" ? getConfigKeyDefinition(config) : config;
  if (!definition?.multiPicker) {
    return null;
  }

  const optionIds = getDefinitionMultiOptions(definition);
  if (optionIds.length === 0) {
    return null;
  }

  return {
    options: optionIds.map((optionId) => ({ id: optionId, label: optionId })),
    currentIds: definition.multiPicker.currentIds(chat),
  };
}

/**
 * Show a detailed help page for one user-facing config key.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {string} key
 * @param {{ getActions?: () => Promise<Action[]>, compact?: boolean }} extra
 * @returns {Promise<string>}
 */
export async function describeConfigKey(rootDb, chatId, key, extra) {
  const definition = getConfigKeyDefinition(key);
  if (!definition) {
    return `Unknown config key \`${key}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
  }

  const chat = await getChatOrThrow(rootDb, chatId);
  const current = await formatCurrentValue(chat, definition, extra);
  const options = getDefinitionOptions(definition);
  const flags = definition.flags ?? [];
  const title = formatSettingTitle(definition.label);
  const lines = [
    `*${title}*`,
    `- Current: ${current}`,
    `- Default: ${formatDefaultValue(definition)}`,
    `- What it does: ${definition.description}`,
  ];

  if (!extra.compact && options.length > 0) {
    lines.push("");
    lines.push("*Options*");
    lines.push(...options.map((option) => `- ${option}`));
  }

  if (!extra.compact && flags.length > 0) {
    lines.push("");
    lines.push("*Controls*");
    lines.push(...flags.map((flag) => `- ${flag.label}: ${flag.description} Default: ${flag.defaultValue ? "on" : "off"}.`));
  }

  if (!extra.compact) {
    lines.push("");
    lines.push("*Examples*");
    lines.push(...definition.examples.map((example) => `- ${example}`));
  }

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
  const chat = await getChatOrThrow(rootDb, chatId);
  return definition.setValue({ rootDb, chatId, chat, value, extra });
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
  const chat = await getChatOrThrow(rootDb, chatId);
  return definition.setValue({ rootDb, chatId, chat, value: "", extra });
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
  const definition = CONFIG_SETTING_MAP.get(setting);
  if (!definition) {
    return `Unknown setting: ${setting}`;
  }
  const current = await definition.formatCurrent(chat, extra);
  const options = getDefinitionOptions(definition);
  const lines = [`${formatSettingTitle(definition.label)}: ${current}`];
  if (options.length > 0) {
    lines.push(`Available: ${options.join(", ")}`);
  }
  return lines.join("\n");
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
  const definition = CONFIG_SETTING_MAP.get(setting);
  if (!definition) {
    return `Unknown setting: ${setting}`;
  }
  return definition.setValue({ rootDb, chatId, chat, value, extra });
}
