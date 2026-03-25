import { getChatOrThrow } from "../../../store.js";
import {
  getSelectableOptions,
  isMaster,
  setChatSetting,
} from "../chatSettings/_service.js";

/**
 * @typedef {{
 *   setting: "enabled" | "trigger" | "memory" | "debug";
 *   question: string;
 * }} BasicSetupStep
 */

/** @type {BasicSetupStep[]} */
const ALL_SETUP_STEPS = [
  { setting: "enabled", question: "Enable the bot for this chat?" },
  { setting: "trigger", question: "When should the bot reply in group chats?" },
  { setting: "memory", question: "Enable long-term memory for this chat?" },
  { setting: "debug", question: "Enable debug output for this chat?" },
];

/**
 * @param {string[]} senderIds
 * @returns {BasicSetupStep[]}
 */
function getSetupSteps(senderIds) {
  const canSetEnabled = isMaster(senderIds);
  return ALL_SETUP_STEPS.filter((step) => step.setting !== "enabled" || canSetEnabled);
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

    for (const step of steps) {
      const selectable = getSelectableOptions(step.setting, chat);
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
    }

    /** @type {string[]} */
    const applied = [];
    for (const change of stagedChanges) {
      applied.push(await setChatSetting(rootDb, chatId, change.setting, change.value, { senderIds }));
    }

    /** @type {string[]} */
    const notes = [];
    if (!isMaster(senderIds)) {
      notes.push("Enabled setting was skipped because only master users can change it.");
    }

    return [
      "Basic setup complete.",
      "",
      ...applied,
      ...(notes.length > 0 ? ["", ...notes] : []),
      "",
      "Use `!config` for advanced settings like model, prompt, harness, and action toggles.",
    ].join("\n");
  },
});
