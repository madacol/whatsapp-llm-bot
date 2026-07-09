import { existsSync, readdirSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { formatChatSettingsCommand, formatChatSettingsUsage } from "./chat-commands.js";
import { getRootDb, getChatDb } from "./db.js";
import config from "./config.js";
import { validateModel, getModelModalities } from "./models-cache.js";
import { getChatOrThrow, initStore } from "./store.js";
import { ROLE_DEFINITIONS, resolveModel } from "./model-roles.js";
import { listHarnesses } from "#harnesses";
import { createWorkspaceBindingService } from "./workspace-binding-service.js";
import { getChatWorkDir } from "./utils.js";
import { updateChatConfig } from "./chat-config.js";
import {
  OUTPUT_PRESENTATION_PRESETS,
  OUTPUT_PRESENTATION_SETTINGS,
  buildOutputPresentationPresetOverrides,
  formatOutputPresentationOption,
  formatOutputVisibility,
  formatOutputVisibilityDefault,
  getOutputPresentationPresetDefinition,
  getOutputPresentationPresetForVisibility,
  getOutputPresentationLabel,
  parseOutputPresentationSetting,
  resolveOutputVisibility,
  setOutputPresentationOverride,
} from "./chat-output-visibility.js";

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
  "harness",
  "harness_cwd",
  "output_visibility",
];

const RESPOND_ON_VALUES = ["any", "mention+reply", "mention"];
const CHAT_WORKSPACE_DEFAULT_LABEL = "chat workspace default";
const BOOL_VALUE_IDS = ["on", "off"];
const SHOW_CUSTOM_OPTION_ID = "custom";

/**
 * @typedef {{
 *   currentId: (chat: import("./store.js").ChatRow) => string;
 *   options?: readonly string[];
 *   getOptions?: () => readonly string[];
 *   alwaysSelect?: boolean;
 * }} ConfigPickerDefinition
 */

/**
 * @typedef {{
 *   currentIds: (chat: import("./store.js").ChatRow) => string[];
 *   options?: readonly SelectOption[];
 *   getOptions?: (chat: import("./store.js").ChatRow) => readonly SelectOption[];
 * }} ConfigMultiPickerDefinition
 */

/**
 * @typedef {{
 *   rootDb: ChatDb;
 *   chatId: string;
 *   chat: import("./store.js").ChatRow;
 *   value: string;
 *   extra: { senderIds?: string[], rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb };
 * }} ConfigSetContext
 */

/**
 * @typedef {(chat: import("./store.js").ChatRow, extra: { rootDb?: ChatDb, chatId?: string, getChatDb?: (chatId: string) => ChatDb }) => string | Promise<string>} ConfigCurrentFormatter
 */

/**
 * @typedef {() => string} ConfigDefaultFormatter
 */

/**
 * @typedef {(context: ConfigSetContext) => Promise<string>} ConfigSetter
 */

/**
 * @template TState
 * @typedef {{
 *   kind: "next";
 *   step: string;
 *   state: TState;
 * } | {
 *   kind: "complete";
 *   result: string;
 * } | {
 *   kind: "cancel";
 * }} ConfigSelectFlowTransition
 */

/**
 * @template TState
 * @typedef {{
 *   prompt: (state: TState) => string | Promise<string>;
 *   options: (state: TState) => SelectOption[] | Promise<SelectOption[]>;
 *   currentId?: (state: TState) => string | undefined;
 *   apply: (state: TState, selectedId: string) => ConfigSelectFlowTransition<TState> | Promise<ConfigSelectFlowTransition<TState>>;
 * }} ConfigSelectFlowStep
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
 * Run an ordered or branching picker flow using WhatsApp's single-select primitive.
 * @template TState
 * @param {{
 *   select: (question: string, options: SelectOption[], config?: { deleteOnSelect?: boolean, currentId?: string }) => Promise<string>;
 *   startStep: string;
 *   initialState: TState;
 *   steps: Record<string, ConfigSelectFlowStep<TState>>;
 *   fallback: () => string | Promise<string>;
 *   maxSteps?: number;
 * }} flow
 * @returns {Promise<string>}
 */
async function runSelectFlow(flow) {
  let state = flow.initialState;
  let stepId = flow.startStep;
  const maxSteps = flow.maxSteps ?? 8;

  for (let index = 0; index < maxSteps; index += 1) {
    const step = flow.steps[stepId];
    if (!step) {
      return flow.fallback();
    }
    const options = await step.options(state);
    if (options.length === 0) {
      return flow.fallback();
    }
    const currentId = step.currentId?.(state);
    const selectedId = await flow.select(
      await step.prompt(state),
      options,
      {
        deleteOnSelect: true,
        ...(currentId ? { currentId } : {}),
      },
    );
    if (!selectedId) {
      return flow.fallback();
    }

    const transition = await step.apply(state, selectedId);
    switch (transition.kind) {
      case "next":
        state = transition.state;
        stepId = transition.step;
        break;
      case "complete":
        return transition.result;
      case "cancel":
        return flow.fallback();
      default: {
        /** @type {never} */
        const exhaustive = transition;
        throw new Error(`Unsupported select-flow transition: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return flow.fallback();
}

/**
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {import("./store.js").ChatRow} chat
 * @returns {Promise<string>}
 */
async function formatResolvedWorkspacePath(rootDb, chatId, chat) {
  if (chat.harness_cwd) {
    return `\`${chat.harness_cwd}\``;
  }

  const store = await initStore(rootDb);
  const binding = await createWorkspaceBindingService(store).resolveChatBinding(chatId, chat.harness_cwd);
  switch (binding.kind) {
    case "project":
      return `\`${binding.project.root_path}\``;
    case "workspace":
      return `\`${binding.workspace.worktree_path}\``;
    case "unbound":
    default:
      return `\`${getChatWorkDir(chatId, chat.harness_cwd)}\``;
  }
}

/**
 * @returns {string[]}
 */
function formatOutputPresentationSettingLines() {
  return OUTPUT_PRESENTATION_SETTINGS.map((setting) => {
    const options = setting.options.map((option) => formatOutputPresentationOption(option)).join(", ");
    return `- ${setting.label}: ${options}`;
  });
}

/**
 * @returns {string[]}
 */
function formatOutputPresentationPresetLines() {
  return [
    ...OUTPUT_PRESENTATION_PRESETS.map((preset) => `- ${preset.label}: ${preset.description}`),
    "- custom: configure individual categories",
  ];
}

/**
 * @param {import("./store.js").ChatRow} chat
 * @returns {string}
 */
function getShowCurrentPresetId(chat) {
  return getOutputPresentationPresetForVisibility(chat.output_visibility)?.key ?? SHOW_CUSTOM_OPTION_ID;
}

/**
 * @returns {SelectOption[]}
 */
function getShowPresetSelectOptions() {
  return [
    ...OUTPUT_PRESENTATION_PRESETS.map((preset) => ({
      id: preset.key,
      label: `${preset.label}: ${preset.description}`,
    })),
    {
      id: SHOW_CUSTOM_OPTION_ID,
      label: "custom: configure individual categories",
    },
  ];
}

/**
 * @param {import("./store.js").ChatRow} chat
 * @returns {string}
 */
function formatShowPresetSelectPrompt(chat) {
  const currentPreset = getOutputPresentationPresetForVisibility(chat.output_visibility);
  return [
    "*Show*",
    `- Current preset: ${currentPreset?.label ?? "custom"}`,
    `- Current: ${formatOutputVisibility(chat.output_visibility)}`,
    "",
    "Choose a preset, or choose custom for individual settings.",
  ].join("\n");
}

/**
 * @param {import("./store.js").ChatRow} chat
 * @returns {SelectOption[]}
 */
function getShowCategorySelectOptions(chat) {
  const visibility = resolveOutputVisibility(chat.output_visibility);
  return OUTPUT_PRESENTATION_SETTINGS.map((setting) => ({
    id: setting.key,
    label: `${setting.label}: ${formatOutputPresentationOption(visibility[setting.key])}`,
  }));
}

/**
 * @param {import("./store.js").ChatRow} chat
 * @returns {string}
 */
function formatShowCategorySelectPrompt(chat) {
  return [
    "*Show*",
    `- Current: ${formatOutputVisibility(chat.output_visibility)}`,
    "",
    "Choose what to configure.",
  ].join("\n");
}

/**
 * @param {typeof OUTPUT_PRESENTATION_SETTINGS[number]} setting
 * @param {string} currentOption
 * @returns {string}
 */
function formatShowOptionSelectPrompt(setting, currentOption) {
  return [
    `*Show: ${setting.label}*`,
    `- Current: ${formatOutputPresentationOption(currentOption)}`,
    "",
    "Choose how to show it.",
  ].join("\n");
}

/**
 * @param {typeof OUTPUT_PRESENTATION_SETTINGS[number]} setting
 * @returns {SelectOption[]}
 */
function getShowOptionSelectOptions(setting) {
  return setting.options.map((option) => ({
    id: option,
    label: formatOutputPresentationOption(option),
  }));
}

/**
 * @param {string} key
 * @returns {typeof OUTPUT_PRESENTATION_SETTINGS[number] | null}
 */
function getOutputPresentationSettingByKey(key) {
  return OUTPUT_PRESENTATION_SETTINGS.find((setting) => setting.key === key) ?? null;
}

/**
 * @param {unknown} previousRaw
 * @param {unknown} nextRaw
 * @returns {string}
 */
function formatOutputVisibilityChanges(previousRaw, nextRaw) {
  const previous = resolveOutputVisibility(previousRaw);
  const next = resolveOutputVisibility(nextRaw);
  /** @type {string[]} */
  const changes = [];
  for (const setting of OUTPUT_PRESENTATION_SETTINGS) {
    const before = previous[setting.key];
    const after = next[setting.key];
    if (before === after) {
      continue;
    }
    changes.push(`${setting.label}: ${formatOutputPresentationOption(before)} -> ${formatOutputPresentationOption(after)}`);
  }
  return changes.length > 0 ? `Show updated: ${changes.join("; ")}.` : "No changes.";
}

/**
 * @typedef {{
 *   chat: import("./store.js").ChatRow;
 *   setting?: typeof OUTPUT_PRESENTATION_SETTINGS[number];
 * }} ShowSettingsFlowState
 */

/**
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {{
 *   select?: ExecuteActionContext["select"],
 *   getIsAdmin?: ExecuteActionContext["getIsAdmin"],
 * }} context
 * @param {{ senderIds?: string[], rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb }} serviceExtra
 * @returns {Promise<string>}
 */
async function runInteractiveShowSettings(rootDb, chatId, context, serviceExtra) {
  if (typeof context.select !== "function") {
    return describeConfigKey(rootDb, chatId, "show", serviceExtra);
  }

  const chat = await getChatOrThrow(rootDb, chatId);
  /** @type {ShowSettingsFlowState} */
  const initialState = { chat };
  return runSelectFlow({
    select: context.select,
    startStep: "preset",
    initialState,
    fallback: () => describeConfigKey(rootDb, chatId, "show", serviceExtra),
    steps: {
      preset: {
        prompt: (state) => formatShowPresetSelectPrompt(state.chat),
        options: () => getShowPresetSelectOptions(),
        currentId: (state) => getShowCurrentPresetId(state.chat),
        apply: async (state, selectedId) => {
          if (selectedId === SHOW_CUSTOM_OPTION_ID) {
            return {
              kind: "next",
              step: "category",
              state,
            };
          }
          const selectedPreset = getOutputPresentationPresetDefinition(selectedId);
          if (!selectedPreset) {
            return { kind: "cancel" };
          }
          const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
          if (!isAdmin) {
            return { kind: "complete", result: "Only admins can change settings." };
          }
          const nextVisibility = buildOutputPresentationPresetOverrides(selectedPreset);
          await updateChatSettingsFile(chatId, { output_visibility: nextVisibility });
          return {
            kind: "complete",
            result: `Show preset set to ${selectedPreset.label}. ${formatOutputVisibilityChanges(state.chat.output_visibility, nextVisibility)}`,
          };
        },
      },
      category: {
        prompt: (state) => formatShowCategorySelectPrompt(state.chat),
        options: (state) => getShowCategorySelectOptions(state.chat),
        apply: (state, selectedId) => {
          const selectedSetting = getOutputPresentationSettingByKey(selectedId);
          if (!selectedSetting) {
            return { kind: "cancel" };
          }
          return {
            kind: "next",
            step: "option",
            state: {
              ...state,
              setting: selectedSetting,
            },
          };
        },
      },
      option: {
        prompt: (state) => {
          if (!state.setting) {
            return "*Show*";
          }
          const visibility = resolveOutputVisibility(state.chat.output_visibility);
          return formatShowOptionSelectPrompt(state.setting, visibility[state.setting.key]);
        },
        options: (state) => state.setting ? getShowOptionSelectOptions(state.setting) : [],
        currentId: (state) => {
          if (!state.setting) {
            return undefined;
          }
          const visibility = resolveOutputVisibility(state.chat.output_visibility);
          return visibility[state.setting.key];
        },
        apply: async (state, selectedId) => {
          if (!state.setting || !state.setting.options.includes(selectedId)) {
            return { kind: "cancel" };
          }
          const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
          if (!isAdmin) {
            return { kind: "complete", result: "Only admins can change settings." };
          }
          const nextVisibility = setOutputPresentationOverride(state.chat.output_visibility, state.setting.key, selectedId);
          await updateChatSettingsFile(chatId, { output_visibility: nextVisibility });
          return {
            kind: "complete",
            result: `${state.setting.label} set to ${formatOutputPresentationOption(selectedId)}. ${formatOutputVisibilityChanges(state.chat.output_visibility, nextVisibility)}`,
          };
        },
      },
    },
  });
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

/**
 * @param {string} chatId
 * @param {Record<string, unknown>} patch
 * @returns {Promise<import("./store.js").ChatRow>}
 */
async function updateChatSettingsFile(chatId, patch) {
  return updateChatConfig(chatId, (current) => ({ ...current, ...patch }));
}

/** @type {ConfigKeyDefinition[]} */
const BASE_CONFIG_KEYS = [
  createConfigKeyDefinition({
    key: "enabled",
    setting: "enabled",
    label: "enabled",
    description: "Turns the bot on or off for this chat. Master users can add a target chat ID to change another chat from here.",
    examples: [
      formatChatSettingsCommand("enabled on"),
      formatChatSettingsCommand("enabled off"),
      formatChatSettingsCommand("enabled on 584146747205@s.whatsapp.net"),
    ],
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
      const { enabled, targetChatId } = parseEnabledValue(value, chatId);
      const targetDb = targetChatId === chatId
        ? rootDb
        : extra.getChatDb?.(targetChatId) ?? rootDb;
      const rootCatalogDb = extra.rootDb ?? rootDb;
      if (rootCatalogDb !== targetDb) {
        await rootCatalogDb.sql`INSERT INTO chats(chat_id) VALUES (${targetChatId}) ON CONFLICT (chat_id) DO NOTHING`;
      }
      await updateChatSettingsFile(targetChatId, { is_enabled: enabled });
      return targetChatId === chatId
        ? `Bot ${enabled ? "enabled" : "disabled"}.`
        : `Bot ${enabled ? "enabled" : "disabled"} for chat \`${targetChatId}\`.`;
    },
  }),
  createConfigKeyDefinition({
    key: "model",
    setting: "model",
    label: "model",
    description: "Chooses the main chat model for this chat.",
    examples: [formatChatSettingsCommand("model gpt-5.4"), formatChatSettingsCommand("reset model")],
    resettable: true,
    formatCurrent: (chat) => chat.model ?? `${resolveModel("chat")} (default)`,
    formatDefault: () => resolveModel("chat"),
    setValue: async ({ chatId, value }) => {
      const trimmed = value.trim();
      const modelValue = trimmed.length === 0 ? null : trimmed;
      if (modelValue) {
        const error = await validateModel(modelValue);
        if (error) return error;
      }
      await updateChatSettingsFile(chatId, { model: modelValue });
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
    examples: [formatChatSettingsCommand("prompt Be concise and skeptical."), formatChatSettingsCommand("reset prompt")],
    resettable: true,
    formatCurrent: (chat) => chat.system_prompt ?? `${config.system_prompt} (default)`,
    formatDefault: () => config.system_prompt,
    setValue: async ({ chatId, value }) => {
      const trimmed = value.trim();
      const newPrompt = trimmed.length === 0 ? null : trimmed;
      await updateChatSettingsFile(chatId, { system_prompt: newPrompt });
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
    examples: [formatChatSettingsCommand("trigger mention"), formatChatSettingsCommand("trigger mention+reply"), formatChatSettingsCommand("trigger any")],
    picker: {
      options: RESPOND_ON_VALUES,
      currentId: (chat) => chat.respond_on ?? "mention",
    },
    formatCurrent: (chat) => chat.respond_on ?? "mention",
    formatDefault: () => "mention",
    setValue: async ({ chatId, value }) => {
      const trimmed = value.trim().toLowerCase();
      if (!RESPOND_ON_VALUES.includes(trimmed)) {
        return `Invalid value. Must be one of: ${RESPOND_ON_VALUES.join(", ")}`;
      }
      await updateChatSettingsFile(chatId, { respond_on: trimmed });
      return `Trigger: ${trimmed}`;
    },
  }),
  createConfigKeyDefinition({
    key: "memory",
    setting: "memory",
    label: "memory",
    description: "Turns long-term memory on or off for this chat.",
    examples: [formatChatSettingsCommand("memory on"), formatChatSettingsCommand("memory off")],
    picker: {
      options: BOOL_VALUE_IDS,
      currentId: (chat) => chat.memory ? "on" : "off",
    },
    formatCurrent: (chat) => formatBoolValue(chat.memory),
    formatDefault: () => "off",
    setValue: async ({ chatId, value }) => {
      const enabled = toBool(value);
      await updateChatSettingsFile(chatId, { memory: enabled });
      return `Long-term memory ${enabled ? "enabled" : "disabled"} for this chat.`;
    },
  }),
  createConfigKeyDefinition({
    key: "threshold",
    setting: "memory_threshold",
    label: "threshold",
    description: "Sets the similarity threshold used when recalling memories.",
    aliases: ["memory_threshold"],
    examples: [formatChatSettingsCommand("threshold 0.7"), formatChatSettingsCommand("reset threshold")],
    resettable: true,
    formatCurrent: (chat) => String(chat.memory_threshold ?? config.memory_threshold),
    formatDefault: () => String(config.memory_threshold),
    setValue: async ({ chatId, value }) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await updateChatSettingsFile(chatId, { memory_threshold: null });
        return `Memory threshold reset to default (${config.memory_threshold}).`;
      }
      const threshold = parseFloat(trimmed);
      if (isNaN(threshold) || threshold < 0 || threshold > 1) {
        throw new Error("Threshold must be a number between 0 and 1.");
      }
      await updateChatSettingsFile(chatId, { memory_threshold: threshold });
      return `Memory similarity threshold set to ${threshold} for this chat.`;
    },
  }),
  createConfigKeyDefinition({
    key: "debug",
    setting: "debug",
    label: "debug",
    description: "Shows extra internal debugging details in this chat.",
    examples: [formatChatSettingsCommand("debug on"), formatChatSettingsCommand("debug off")],
    picker: {
      options: BOOL_VALUE_IDS,
      currentId: (chat) => chat.debug ? "on" : "off",
    },
    formatCurrent: (chat) => formatBoolValue(chat.debug),
    formatDefault: () => "off",
    setValue: async ({ chatId, value }) => {
      const enabled = toBool(value);
      await updateChatSettingsFile(chatId, { debug: enabled });
      return `Debug ${enabled ? "on" : "off"}.`;
    },
  }),
  createConfigKeyDefinition({
    key: "harness",
    setting: "harness",
    label: "harness",
    description: "Chooses which ACP harness runs the conversation.",
    examples: [formatChatSettingsCommand("harness codex"), formatChatSettingsCommand("reset harness")],
    picker: {
      getOptions: () => listHarnesses(),
      currentId: (chat) => chat.harness ?? config.default_harness,
      alwaysSelect: true,
    },
    resettable: true,
    formatCurrent: (chat) => chat.harness ?? `default (${config.default_harness || "none"})`,
    formatDefault: () => config.default_harness || "none",
    setValue: async ({ chatId, value }) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await updateChatSettingsFile(chatId, { harness: null });
        return `Harness reset. This chat will use the central default (${config.default_harness || "none"}).`;
      }
      const available = listHarnesses();
      if (!available.includes(trimmed)) {
        return `Unknown harness \`${trimmed}\`. Available: ${available.join(", ")}`;
      }
      await updateChatSettingsFile(chatId, { harness: trimmed });
      return `Harness set to \`${trimmed}\``;
    },
  }),
  createConfigKeyDefinition({
    key: "show",
    setting: "output_visibility",
    label: "show",
    description: "Controls side-channel presentation categories for WhatsApp.",
    aliases: ["output_visibility", "output-visibility"],
    examples: [
      formatChatSettingsCommand("show"),
      formatChatSettingsCommand("show compact"),
      formatChatSettingsCommand("show minimal"),
      formatChatSettingsCommand("show reasoning hidden"),
      formatChatSettingsCommand("show tools pinned"),
      formatChatSettingsCommand("show snapshots off"),
      formatChatSettingsCommand("show middle assistant messages off"),
      formatChatSettingsCommand("reset show"),
    ],
    resettable: true,
    formatCurrent: (chat) => formatOutputVisibility(chat.output_visibility),
    formatDefault: () => formatOutputVisibilityDefault(),
    setValue: async ({ chatId, chat, value }) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        await updateChatSettingsFile(chatId, { output_visibility: {} });
        return `Show reset to defaults (${formatOutputVisibilityDefault()}).`;
      }

      const preset = getOutputPresentationPresetDefinition(trimmed);
      if (preset) {
        const nextVisibility = buildOutputPresentationPresetOverrides(preset);
        await updateChatSettingsFile(chatId, { output_visibility: nextVisibility });
        return `Show preset set to ${preset.label}. ${formatOutputVisibilityChanges(chat.output_visibility, nextVisibility)}`;
      }

      const parsed = parseOutputPresentationSetting(trimmed);
      if (!parsed) {
        return [
          `Use \`${formatChatSettingsCommand("show <preset>")}\` or \`${formatChatSettingsCommand("show <category> <option>")}\`.`,
          "",
          "*Presets*",
          ...formatOutputPresentationPresetLines(),
          "",
          "*Categories*",
          ...formatOutputPresentationSettingLines(),
        ].join("\n");
      }
      const nextVisibility = setOutputPresentationOverride(chat.output_visibility, parsed.key, parsed.option);
      await updateChatSettingsFile(chatId, { output_visibility: nextVisibility });
      const label = getOutputPresentationLabel(parsed.key);
      return `${label} set to ${formatOutputPresentationOption(parsed.option)}. ${formatOutputVisibilityChanges(chat.output_visibility, nextVisibility)}`;
    },
  }),
  createConfigKeyDefinition({
    key: "workspace",
    setting: "harness_cwd",
    label: "workspace",
    description: "Sets the active workspace path for this chat. Harnesses run here, and workspace commands resolve project/worktree metadata from this path.",
    aliases: ["folder", "harness_cwd"],
    examples: [
      formatChatSettingsCommand("workspace /home/mada/project"),
      formatChatSettingsCommand("reset workspace"),
      formatChatSettingsCommand("folder /home/mada/project"),
    ],
    resettable: true,
    formatCurrent: (chat, extra) => {
      if (!extra.rootDb || !extra.chatId) {
        return chat.harness_cwd ?? CHAT_WORKSPACE_DEFAULT_LABEL;
      }
      return formatResolvedWorkspacePath(extra.rootDb, extra.chatId, chat);
    },
    formatDefault: () => CHAT_WORKSPACE_DEFAULT_LABEL,
    setValue: async ({ chatId, value }) => {
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

      await updateChatSettingsFile(chatId, { harness_cwd: cwdValue });
      return cwdValue
        ? `Workspace path set to \`${cwdValue}\``
        : `Workspace path cleared; using ${CHAT_WORKSPACE_DEFAULT_LABEL}.`;
    },
  }),
  createConfigKeyDefinition({
    key: "media-reader",
    setting: "media_to_text_model",
    label: "media-reader",
    description: "Sets the fallback model used to read image, audio, and video inputs.",
    aliases: ["media_to_text_model"],
    examples: [formatChatSettingsCommand("media-reader openai/gpt-4.1"), formatChatSettingsCommand("reset media-reader")],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.general ?? "default",
    formatDefault: () => "default",
    setValue: async ({ chatId, chat, value }) => {
      const trimmed = value.trim();
      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.general;
        await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
        return "media-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.some((m) => ["image", "audio", "video"].includes(m))) {
        return `Model \`${trimmed}\` does not support any media input (image, audio, or video).`;
      }

      currentModels.general = trimmed;
      await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
      return `media-to-text model set to \`${trimmed}\``;
    },
  }),
  createConfigKeyDefinition({
    key: "image-reader",
    setting: "image_to_text_model",
    label: "image-reader",
    description: "Sets the model used to read images in this chat.",
    aliases: ["image_to_text_model"],
    examples: [formatChatSettingsCommand("image-reader openai/gpt-4.1"), formatChatSettingsCommand("reset image-reader")],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.image ?? "default",
    formatDefault: () => "default",
    setValue: async ({ chatId, chat, value }) => {
      const trimmed = value.trim();
      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.image;
        await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
        return "image-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes("image")) {
        return `Model \`${trimmed}\` does not support \`image\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      currentModels.image = trimmed;
      await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
      return `image-to-text model set to \`${trimmed}\``;
    },
  }),
  createConfigKeyDefinition({
    key: "audio-reader",
    setting: "audio_to_text_model",
    label: "audio-reader",
    description: "Sets the model used to read audio in this chat.",
    aliases: ["audio_to_text_model"],
    examples: [formatChatSettingsCommand("audio-reader openai/gpt-4.1"), formatChatSettingsCommand("reset audio-reader")],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.audio ?? "default",
    formatDefault: () => "default",
    setValue: async ({ chatId, chat, value }) => {
      const trimmed = value.trim();
      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.audio;
        await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
        return "audio-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes("audio")) {
        return `Model \`${trimmed}\` does not support \`audio\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      currentModels.audio = trimmed;
      await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
      return `audio-to-text model set to \`${trimmed}\``;
    },
  }),
  createConfigKeyDefinition({
    key: "video-reader",
    setting: "video_to_text_model",
    label: "video-reader",
    description: "Sets the model used to read videos in this chat.",
    aliases: ["video_to_text_model"],
    examples: [formatChatSettingsCommand("video-reader openai/gpt-4.1"), formatChatSettingsCommand("reset video-reader")],
    resettable: true,
    formatCurrent: (chat) => chat.media_to_text_models?.video ?? "default",
    formatDefault: () => "default",
    setValue: async ({ chatId, chat, value }) => {
      const trimmed = value.trim();
      const currentModels = { ...(chat.media_to_text_models ?? {}) };
      if (trimmed.length === 0) {
        delete currentModels.video;
        await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
        return "video-reader reset to default.";
      }

      const error = await validateModel(trimmed);
      if (error) return error;

      const modalities = await getModelModalities(trimmed);
      if (!modalities.includes("video")) {
        return `Model \`${trimmed}\` does not support \`video\` input. Its supported modalities are: ${modalities.join(", ")}`;
      }

      currentModels.video = trimmed;
      await updateChatSettingsFile(chatId, { media_to_text_models: currentModels });
      return `video-to-text model set to \`${trimmed}\``;
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
    examples: [
      formatChatSettingsCommand(`${roleSettingToFriendlyKey(roleName)} openai/gpt-4.1`),
      formatChatSettingsCommand(`reset ${roleSettingToFriendlyKey(roleName)}`),
    ],
    resettable: true,
    formatCurrent: (chat) => chat.model_roles?.[roleName] ?? "default",
    formatDefault: () => resolveModel(roleName),
    setValue: async ({ chatId, chat, value }) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        const currentRoles = { ...(chat.model_roles ?? {}) };
        delete currentRoles[roleName];
        await updateChatSettingsFile(chatId, { model_roles: currentRoles });
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
      await updateChatSettingsFile(chatId, { model_roles: currentRoles });
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
export const CONFIG_KEY_INPUTS = [...new Set(
  CONFIG_KEY_DEFINITIONS.flatMap((definition) => [definition.key, ...(definition.aliases ?? [])]),
)];

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
 * Parse `enabled` values. Supports both:
 * - `on`
 * - `on <chatId>`
 * - `<chatId> on`
 * @param {string} rawValue
 * @param {string} currentChatId
 * @returns {{ enabled: boolean, targetChatId: string }}
 */
function parseEnabledValue(rawValue, currentChatId) {
  const parts = rawValue.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Missing enabled value. Use `on` or `off`.");
  }
  if (parts.length === 1) {
    return { enabled: toBool(parts[0]), targetChatId: currentChatId };
  }
  if (parts.length === 2) {
    try {
      return { enabled: toBool(parts[0]), targetChatId: parts[1] };
    } catch (firstError) {
      try {
        return { enabled: toBool(parts[1]), targetChatId: parts[0] };
      } catch {
        throw firstError;
      }
    }
  }
  throw new Error("Use `enabled on`, `enabled off`, `enabled on <chatId>`, or `enabled <chatId> on`.");
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
 * @param {string} key
 * @returns {ConfigKeyDefinition | null}
 */
export function getConfigKeyDefinition(key) {
  return CONFIG_KEY_MAP.get(key.trim().toLowerCase()) ?? null;
}

/**
 * @param {import("./store.js").ChatRow} chat
 * @param {ConfigKeyDefinition} definition
 * @param {{ rootDb?: ChatDb, chatId?: string, getChatDb?: (chatId: string) => ChatDb }} extra
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
 * @param {import("./store.js").ChatRow} chat
 * @returns {SelectOption[]}
 */
function getDefinitionMultiOptions(definition, chat) {
  if (definition.multiPicker?.options) {
    return [...definition.multiPicker.options];
  }
  if (definition.multiPicker?.getOptions) {
    return [...definition.multiPicker.getOptions(chat)];
  }
  return [];
}

/**
 * Show a full summary of all chat settings.
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {{ senderIds?: string[], rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb }} extra
 * @returns {Promise<string>}
 */
export async function getChatSettingsInfo(rootDb, chatId, extra) {
  const chat = await getChatOrThrow(rootDb, chatId);
  const senderIds = extra.senderIds ?? [];
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
    ...(!chat.is_enabled
      ? [
        `- enable here: \`${formatChatSettingsCommand("enabled on")}\``,
        `- enable from another chat: \`${formatChatSettingsCommand(`enabled on ${chatId}`)}\``,
      ]
      : []),
    `- model: ${chat.model ?? `${resolveModel("chat")} (default)`}`,
    `- prompt: ${chat.system_prompt ? "custom" : "default"}`,
    `- trigger: ${chat.respond_on ?? "mention"}`,
    `- memory: ${chat.memory ? "on" : "off"}`,
    `- threshold: ${chat.memory_threshold ?? config.memory_threshold}`,
    `- debug: ${chat.debug ? "on" : "off"}`,
    `- show: ${formatOutputVisibility(chat.output_visibility)}`,
    "",
    "Harness",
    `- harness: ${chat.harness ?? `default (${config.default_harness || "none"})`}`,
    `- workspace: ${await formatResolvedWorkspacePath(extra.rootDb ?? rootDb, chatId, chat)}`,
    "",
    "Models",
    `- readers: media=${chat.media_to_text_models?.general ?? "default"}, image=${chat.media_to_text_models?.image ?? "default"}, audio=${chat.media_to_text_models?.audio ?? "default"}, video=${chat.media_to_text_models?.video ?? "default"}`,
    `- overrides: ${roleOverrides}`,
    "",
    "Use",
    `- \`${formatChatSettingsCommand("<key>")}\` to inspect a setting`,
    `- \`${formatChatSettingsCommand("help <key>")}\` for the full description and examples`,
    `- \`${formatChatSettingsCommand("reset <key>")}\` to revert a resettable setting`,
  ];

  return lines.join("\n");
}

/**
 * Return selectable options and the current value id for settings with fewer
 * than 5 fixed choices, or settings that opt into selection. Returns `null`
 * if the setting is free-text.
 *
 * @param {string | ConfigKeyDefinition} config
 * @param {import("./store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentId: string } | null}
 */
export function getSelectableOptions(config, chat) {
  const definition = typeof config === "string" ? getConfigKeyDefinition(config) : config;
  if (!definition?.picker) {
    return null;
  }

  const optionIds = getDefinitionOptions(definition);
  if (optionIds.length === 0 || (optionIds.length >= 5 && definition.picker.alwaysSelect !== true)) {
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
 * @param {import("./store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentIds: string[] } | null}
 */
export function getMultiSelectableOptions(config, chat) {
  const definition = typeof config === "string" ? getConfigKeyDefinition(config) : config;
  if (!definition?.multiPicker) {
    return null;
  }

  const options = getDefinitionMultiOptions(definition, chat);
  if (options.length === 0) {
    return null;
  }

  return {
    options: options.map((option) => typeof option === "string" ? { id: option, label: option } : option),
    currentIds: definition.multiPicker.currentIds(chat),
  };
}

/**
 * Show a detailed help page for one user-facing config key.
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {string} key
 * @param {{ compact?: boolean, rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb }} extra
 * @returns {Promise<string>}
 */
export async function describeConfigKey(rootDb, chatId, key, extra) {
  const definition = getConfigKeyDefinition(key);
  if (!definition) {
    return `Unknown config key \`${key}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
  }

  if (extra.compact && definition.key === "show") {
    return `Use \`${formatChatSettingsCommand("show")}\` to choose a preset, or \`${formatChatSettingsCommand("show <category> <option>")}\` for custom output.`;
  }

  const chat = await getChatOrThrow(rootDb, chatId);
  const current = await formatCurrentValue(chat, definition, { ...extra, rootDb: extra.rootDb ?? rootDb, chatId });
  const options = getDefinitionOptions(definition);
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

  if (!extra.compact && definition.key === "show") {
    lines.push("");
    lines.push("*Presets*");
    lines.push(...formatOutputPresentationPresetLines());
    lines.push("");
    lines.push("*Categories*");
    lines.push(...formatOutputPresentationSettingLines());
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
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {string} key
 * @param {string} value
 * @param {{ senderIds?: string[], rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb }} extra
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
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {string} key
 * @param {{ senderIds?: string[], rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb }} extra
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
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {string} setting
 * @param {{ rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb }} extra
 * @returns {Promise<string>}
 */
export async function getChatSetting(rootDb, chatId, setting, extra) {
  const chat = await getChatOrThrow(rootDb, chatId);
  const definition = CONFIG_SETTING_MAP.get(setting);
  if (!definition) {
    return `Unknown setting: ${setting}`;
  }
  const current = await definition.formatCurrent(chat, { ...extra, rootDb: extra.rootDb ?? rootDb, chatId });
  const options = getDefinitionOptions(definition);
  const lines = [`${formatSettingTitle(definition.label)}: ${current}`];
  if (options.length > 0) {
    lines.push(`Available: ${options.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {string} setting
 * @param {string} value
 * @param {{ senderIds?: string[], rootDb?: ChatDb, getChatDb?: (chatId: string) => ChatDb }} extra
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

/**
 * Run the complete user-facing Chat Settings interaction, including picker
 * prompts, admin checks, set/reset/inspect behavior, and persistence.
 * @param {{
 *   chatId: string,
 *   senderIds?: string[],
 *   getIsAdmin?: ExecuteActionContext["getIsAdmin"],
 *   select?: ExecuteActionContext["select"],
 *   selectMany?: ExecuteActionContext["selectMany"],
 *   rootDb?: import("./sqlite-db.js").SqliteDb,
 * }} context
 * @param {{ setting?: string, value?: string }} params
 * @returns {Promise<string>}
 */
export async function runChatSettingsInteraction(context, { setting, value }) {
  const rootDb = context.rootDb ?? getRootDb();
  const serviceExtra = {
    senderIds: context.senderIds ?? [],
    rootDb,
    getChatDb,
  };

  if (!setting || setting === "list") {
    return getChatSettingsInfo(rootDb, context.chatId, serviceExtra);
  }

  if (setting === "help") {
    const key = value?.trim();
    if (!key) {
      return formatChatSettingsUsage("help <key>");
    }
    return describeConfigKey(rootDb, context.chatId, key, serviceExtra);
  }

  if (setting === "reset") {
    const key = value?.trim();
    if (!key) {
      return formatChatSettingsUsage("reset <key>");
    }
    const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
    if (!isAdmin) {
      return "Only admins can change settings.";
    }
    return resetConfigValue(rootDb, context.chatId, key, serviceExtra);
  }

  if (value === undefined || value === null) {
    const definition = getConfigKeyDefinition(setting);
    if (!definition) {
      return `Unknown config key \`${setting}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
    }
    if (definition.key === "show") {
      return runInteractiveShowSettings(rootDb, context.chatId, context, serviceExtra);
    }
    const chat = await getChatOrThrow(rootDb, context.chatId);
    const multiSelectable = getMultiSelectableOptions(definition, chat);
    if (multiSelectable && typeof context.selectMany === "function") {
      const helpText = await describeConfigKey(rootDb, context.chatId, setting, {
        compact: true,
        rootDb,
        getChatDb,
      });
      const selection = await context.selectMany(
        helpText,
        multiSelectable.options,
        { deleteOnSelect: true, currentIds: multiSelectable.currentIds },
      );
      if (selection.kind === "cancelled") {
        return helpText;
      }
      if (selection.kind === "unchanged") {
        return "";
      }
      const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
      if (!isAdmin) {
        return "Only admins can change settings.";
      }
      return setConfigValue(rootDb, context.chatId, setting, selection.ids.join(" "), serviceExtra);
    }
    const selectable = getSelectableOptions(definition, chat);
    if (selectable && typeof context.select === "function") {
      const helpText = await describeConfigKey(rootDb, context.chatId, setting, {
        compact: true,
        rootDb,
        getChatDb,
      });
      const chosen = await context.select(
        helpText,
        selectable.options,
        { deleteOnSelect: true, currentId: selectable.currentId },
      );
      if (chosen) {
        const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
        if (!isAdmin) {
          return "Only admins can change settings.";
        }
        return setConfigValue(rootDb, context.chatId, setting, chosen, serviceExtra);
      }
      return helpText;
    }
    return describeConfigKey(rootDb, context.chatId, setting, serviceExtra);
  }

  const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
  if (!isAdmin) {
    return "Only admins can change settings.";
  }

  return setConfigValue(rootDb, context.chatId, setting, String(value), serviceExtra);
}
