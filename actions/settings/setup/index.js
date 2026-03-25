import { getScopedHarnessConfig, normalizeHarnessConfig } from "../../../harness-config.js";
import { getChatOrThrow } from "../../../store.js";
import { getHarnessModelOptions as getPublicHarnessModelOptions, listHarnesses, resolveHarness } from "#harnesses";
import {
  getSelectableOptions,
  isMaster,
  setChatSetting,
} from "../chatSettings/_service.js";

/**
 * @typedef {{
 *   setting: "enabled" | "trigger" | "harness" | "debug";
 *   question: string;
 * }} BasicSetupStep
 */

/**
 * @typedef {{
 *   harness: string;
 *   value: string;
 * }} HarnessModelSelection
 */

/** @type {BasicSetupStep[]} */
const ALL_SETUP_STEPS = [
  { setting: "enabled", question: "Enable the bot for this chat?" },
  { setting: "trigger", question: "When should the bot reply in group chats?" },
  { setting: "harness", question: "Which harness should power this chat?" },
  { setting: "debug", question: "Enable debug output for this chat?" },
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string[]} senderIds
 * @returns {BasicSetupStep[]}
 */
function getSetupSteps(senderIds) {
  const canSetEnabled = isMaster(senderIds);
  return ALL_SETUP_STEPS.filter((step) => step.setting !== "enabled" || canSetEnabled);
}

/**
 * @param {import("../../../store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentId: string }}
 */
function getHarnessSelectOptions(chat) {
  return {
    options: listHarnesses().map((harnessName) => ({ id: harnessName, label: harnessName })),
    currentId: chat.harness ?? "native",
  };
}

/**
 * @param {string} harnessName
 * @returns {Promise<SelectOption[]>}
 */
async function getHarnessModelOptions(harnessName) {
  return getPublicHarnessModelOptions(harnessName);
}

/**
 * @param {string} harnessName
 * @returns {string}
 */
function getHarnessModelQuestion(harnessName) {
  if (harnessName === "claude-agent-sdk") {
    return "Choose Claude SDK model";
  }
  if (harnessName === "codex") {
    return "Choose Codex model";
  }
  return "Choose harness model";
}

/**
 * @param {string} harnessName
 * @param {string} modelValue
 * @returns {string}
 */
function formatHarnessModelSummary(harnessName, modelValue) {
  if (harnessName === "claude-agent-sdk") {
    return modelValue === "off"
      ? "SDK model reset to default."
      : `SDK model set to \`${modelValue}\``;
  }
  if (harnessName === "codex") {
    return modelValue === "off"
      ? "Codex model reset to default."
      : `Codex model set to \`${modelValue}\``;
  }
  return modelValue === "off"
    ? `${harnessName} model reset to default.`
    : `${harnessName} model set to \`${modelValue}\``;
}

/**
 * @param {import("../../../store.js").ChatRow} chat
 * @param {string} harnessName
 * @param {SelectOption[]} options
 * @returns {string | undefined}
 */
function getCurrentHarnessModelId(chat, harnessName, options) {
  const scopedConfig = getScopedHarnessConfig(chat.harness_config, harnessName);
  const currentModel = typeof scopedConfig.model === "string" ? scopedConfig.model : undefined;
  if (!currentModel) {
    return undefined;
  }
  const optionIds = new Set(options.map((option) => typeof option === "string" ? option : option.id));
  return optionIds.has(currentModel) ? currentModel : undefined;
}

/**
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {import("../../../store.js").ChatRow} chat
 * @param {HarnessModelSelection} selection
 * @returns {Promise<string>}
 */
async function applyHarnessModelSelection(rootDb, chatId, chat, selection) {
  const normalized = normalizeHarnessConfig(chat.harness_config, chat.harness);
  const rawScoped = normalized[selection.harness];
  /** @type {Record<string, unknown>} */
  const scoped = isObjectRecord(rawScoped) ? { ...rawScoped } : {};

  if (selection.value === "off") {
    delete scoped.model;
  } else {
    scoped.model = selection.value;
  }

  if (Object.keys(scoped).length === 0) {
    delete normalized[selection.harness];
  } else {
    normalized[selection.harness] = scoped;
  }

  await rootDb.sql`
    UPDATE chats
    SET harness_config = ${JSON.stringify(normalized)}::jsonb
    WHERE chat_id = ${chatId}
  `;
  return formatHarnessModelSummary(selection.harness, selection.value);
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "setup",
  command: "setup",
  description: "Guide an admin through the basic chat configuration in one go.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  formatToolCall: () => "Running guided setup",
  permissions: {
    autoExecute: true,
    useRootDb: true,
    requireAdmin: true,
  },
  /**
   * @param {ExtendedActionContext<{autoExecute: true, useRootDb: true, requireAdmin: true}>} context
   * @param {Record<string, never>} _params
   */
  action_fn: async function ({ chatId, rootDb, senderIds, select }, _params) {
    const chat = await getChatOrThrow(rootDb, chatId);
    const steps = getSetupSteps(senderIds);

    if (steps.length === 0) {
      return "No setup steps are available for this chat.";
    }

    /** @type {Array<{ setting: BasicSetupStep['setting'], value: string }>} */
    const stagedChanges = [];
    /** @type {HarnessModelSelection | null} */
    let stagedHarnessModel = null;
    /** @type {string[]} */
    const notes = [];

    for (const step of steps) {
      const selectable = step.setting === "harness"
        ? getHarnessSelectOptions(chat)
        : getSelectableOptions(step.setting, chat);
      if (!selectable) {
        continue;
      }

      const selected = await select(
        step.question,
        selectable.options,
        { deleteOnSelect: true, currentId: selectable.currentId },
      );
      if (!selected) {
        return "Setup cancelled. No changes were made.";
      }

      stagedChanges.push({ setting: step.setting, value: selected });

      if (step.setting !== "harness") {
        continue;
      }

      const selectedHarness = selected;
      const harness = resolveHarness(selectedHarness);
      if (!harness.getCapabilities().supportsModelSelection) {
        notes.push(`${selectedHarness} does not expose a configurable /model setting.`);
        continue;
      }

      const modelOptions = await getHarnessModelOptions(selectedHarness);
      if (modelOptions.length === 0) {
        notes.push(`No selectable ${selectedHarness} models are currently available, so its /model setting was left unchanged.`);
        continue;
      }

      const currentModelId = getCurrentHarnessModelId(chat, selectedHarness, modelOptions);
      const selectedModel = await select(
        getHarnessModelQuestion(selectedHarness),
        modelOptions,
        { deleteOnSelect: true, ...(currentModelId ? { currentId: currentModelId } : {}) },
      );
      if (!selectedModel) {
        return "Setup cancelled. No changes were made.";
      }

      stagedHarnessModel = { harness: selectedHarness, value: selectedModel };
    }

    /** @type {string[]} */
    const applied = [];
    for (const change of stagedChanges) {
      applied.push(await setChatSetting(rootDb, chatId, change.setting, change.value, { senderIds }));
    }
    if (stagedHarnessModel) {
      applied.push(await applyHarnessModelSelection(rootDb, chatId, chat, stagedHarnessModel));
    }

    if (!isMaster(senderIds)) {
      notes.push("Enabled setting was skipped because only master users can change it.");
    }

    return [
      "Basic setup complete.",
      "",
      ...applied,
      ...(notes.length > 0 ? ["", ...notes] : []),
      "",
      "Use `!config` for advanced settings like prompt, media models, cwd, and action toggles.",
    ].join("\n");
  },
});
