import { formatChatSettingsCommand } from "../../../chat-commands.js";
import { getChatOrThrow } from "../../../store.js";
import { getChatDb } from "../../../db.js";
import { listHarnesses } from "#harnesses";
import {
  getSelectableOptions,
  isMaster,
  setConfigValue,
} from "../chatSettings/_service.js";

/**
 * @typedef {{
 *   setting: "trigger" | "harness";
 *   question: string;
 * }} BasicSetupStep
 */

/**
 * @typedef {{
 *   setting: BasicSetupStep["setting"];
 *   value: string;
 * }} StagedConfigChange
 */

/**
 * @typedef {{
 *   kind: "selected";
 *   stagedChanges: StagedConfigChange[];
 *   notes: string[];
 * }} SelectedSetupResult
 */

/** @typedef {SelectedSetupResult | { kind: "cancelled" }} SetupSelectionResult */

/**
 * @typedef {{
 *   applied: string[];
 *   notes: string[];
 * }} AppliedSetupResult
 */

/** @type {BasicSetupStep[]} */
const ALL_SETUP_STEPS = [
  { setting: "trigger", question: "When should the bot reply in group chats?" },
  { setting: "harness", question: "Which harness should power this chat?" },
];

/**
 * @param {import("../../../store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentId: string }}
 */
function getHarnessSelectOptions(chat) {
  return {
    options: listHarnesses().map((harnessName) => ({ id: harnessName, label: harnessName })),
    currentId: chat.harness ?? "",
  };
}

/**
 * @param {import("../../../store.js").ChatRow} chat
 * @param {TurnIO["select"]} select
 * @returns {Promise<SetupSelectionResult>}
 */
async function collectSetupSelections(chat, select) {
  /** @type {StagedConfigChange[]} */
  const stagedChanges = [];
  /** @type {string[]} */
  const notes = [];

  for (const step of ALL_SETUP_STEPS) {
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
      return { kind: "cancelled" };
    }

    stagedChanges.push({ setting: step.setting, value: selected });

    if (step.setting !== "harness") {
      continue;
    }

    notes.push(`Use /config after starting ${selected} to choose ACP-native model, mode, and reasoning options.`);
  }

  return {
    kind: "selected",
    stagedChanges,
    notes,
  };
}

/**
 * @param {ChatDb} rootDb
 * @param {string} chatId
 * @param {import("../../../store.js").ChatRow} chat
 * @param {string[]} senderIds
 * @param {SelectedSetupResult} selections
 * @returns {Promise<AppliedSetupResult>}
 */
async function applySetupSelections(rootDb, chatId, chat, senderIds, selections) {
  /** @type {string[]} */
  const applied = [];
  const notes = [...selections.notes];

  for (const change of selections.stagedChanges) {
    applied.push(await setConfigValue(rootDb, chatId, change.setting, change.value, { senderIds, getChatDb }));
  }
  if (isMaster(senderIds)) {
    if (!chat.is_enabled) {
      applied.push(await setConfigValue(rootDb, chatId, "enabled", "on", { senderIds, getChatDb }));
    }
  } else {
    notes.push("Enabled setting was skipped because only master users can change it.");
  }

  return { applied, notes };
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
    const selections = await collectSetupSelections(chat, select);
    if (selections.kind === "cancelled") {
      return "Setup cancelled. No changes were made.";
    }
    const { applied, notes } = await applySetupSelections(rootDb, chatId, chat, senderIds, selections);

    return [
      "Basic setup complete.",
      "",
      ...applied,
      ...(notes.length > 0 ? ["", ...notes] : []),
      "",
      `Use \`${formatChatSettingsCommand()}\` for advanced settings like prompt, readers, workspace, and action toggles.`,
      "Use `!clone <repository_url>` to clone a git repository into the current working directory.",
    ].join("\n");
  },
});
