import { formatChatSettingsCommand } from "../chat-commands.js";
import { getRootDb, getChatDb } from "../db.js";
import { getChatOrThrow } from "../store.js";
import { listHarnesses } from "#harnesses";
import {
  getSelectableOptions,
  isMaster,
  setConfigValue,
} from "../chat-settings-service.js";

export const SETUP_COMMAND_PARAMETERS = /** @type {Action["parameters"]} */ ({
  type: "object",
  properties: {},
  required: [],
});

/** @type {Array<{ setting: "trigger" | "harness", question: string }>} */
const SETUP_STEPS = [
  { setting: "trigger", question: "When should the bot reply in group chats?" },
  { setting: "harness", question: "Which harness should power this chat?" },
];

/**
 * @param {import("../store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentId: string }}
 */
function getHarnessSelectOptions(chat) {
  return {
    options: listHarnesses().map((harnessName) => ({ id: harnessName, label: harnessName })),
    currentId: chat.harness ?? "",
  };
}

/**
 * @param {import("../store.js").ChatRow} chat
 * @param {TurnIO["select"]} select
 * @returns {Promise<{ kind: "selected", stagedChanges: Array<{ setting: "trigger" | "harness", value: string }>, notes: string[] } | { kind: "cancelled" }>}
 */
async function collectSetupSelections(chat, select) {
  /** @type {Array<{ setting: "trigger" | "harness", value: string }>} */
  const stagedChanges = [];
  /** @type {string[]} */
  const notes = [];

  for (const step of SETUP_STEPS) {
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

    if (step.setting === "harness") {
      notes.push(`Use /config after starting ${selected} to choose ACP-native model, mode, and reasoning options.`);
    }
  }

  return { kind: "selected", stagedChanges, notes };
}

/**
 * @param {ExecuteActionContext} context
 * @returns {Promise<string>}
 */
export async function runSetupCommand(context) {
  const isAdmin = context.getIsAdmin ? await context.getIsAdmin() : true;
  if (!isAdmin) {
    return "Only admins can run setup.";
  }

  const rootDb = getRootDb();
  const chat = await getChatOrThrow(rootDb, context.chatId);
  const selections = await collectSetupSelections(chat, context.select);
  if (selections.kind === "cancelled") {
    return "Setup cancelled. No changes were made.";
  }

  /** @type {string[]} */
  const applied = [];
  const notes = [...selections.notes];
  for (const change of selections.stagedChanges) {
    applied.push(await setConfigValue(rootDb, context.chatId, change.setting, change.value, {
      senderIds: context.senderIds,
      getChatDb,
    }));
  }
  if (isMaster(context.senderIds)) {
    if (!chat.is_enabled) {
      applied.push(await setConfigValue(rootDb, context.chatId, "enabled", "on", {
        senderIds: context.senderIds,
        getChatDb,
      }));
    }
  } else {
    notes.push("Enabled setting was skipped because only master users can change it.");
  }

  return [
    "Basic setup complete.",
    "",
    ...applied,
    ...(notes.length > 0 ? ["", ...notes] : []),
    "",
    `Use \`${formatChatSettingsCommand()}\` for advanced settings like prompt, readers, workspace, and output visibility.`,
  ].join("\n");
}
