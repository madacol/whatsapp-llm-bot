import { getChatOrThrow } from "../../../store.js";
import {
  buildOutputVisibilityOverrides,
  formatOutputVisibility,
  getEnabledOutputVisibilityKeys,
  isOutputVisibilityKey,
  OUTPUT_VISIBILITY_FLAGS,
} from "../../../chat-output-visibility.js";
import {
  CONFIG_KEYS,
  describeConfigKey,
  getConfigKeyDefinition,
  getChatSettingsInfo,
  getSelectableOptions,
  resetConfigValue,
  setConfigValue,
} from "./_service.js";

const SHOW_NONE_OPTION_ID = "none";

/**
 * @param {import("../../../store.js").ChatRow} chat
 * @returns {{ options: SelectOption[], currentIds: string[] }}
 */
function getShowSelectManyOptions(chat) {
  const currentIds = getEnabledOutputVisibilityKeys(chat.output_visibility);
  return {
    options: [
      ...OUTPUT_VISIBILITY_FLAGS.map((flag) => ({ id: flag.key, label: flag.label })),
      { id: SHOW_NONE_OPTION_ID, label: SHOW_NONE_OPTION_ID },
    ],
    currentIds: currentIds.length > 0 ? currentIds : [SHOW_NONE_OPTION_ID],
  };
}

/**
 * @param {string[]} selectedIds
 * @returns {selectedIds is import("../../../chat-output-visibility.js").OutputVisibilityKey[]}
 */
function areOutputVisibilityKeys(selectedIds) {
  return selectedIds.every((id) => isOutputVisibilityKey(id));
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "chat_settings",
  command: "c",
  description:
    `Inspect and change chat settings. Use \`!c\`, \`!c <key>\`, \`!c help <key>\`, \`!c <key> <value>\`, or \`!c reset <key>\`. Keys: ${CONFIG_KEYS.join(", ")}.`,
  parameters: {
    type: "object",
    properties: {
      setting: {
        type: "string",
        enum: ["help", "list", "reset", ...CONFIG_KEYS],
        description: "The config key to inspect or set, or the verb `help` / `reset`",
      },
      value: {
        type: "string",
        description: "The value to set, or the key to reset when `setting` is `reset`",
      },
    },
  },
  formatToolCall: ({ setting, value }) => {
    if (!setting) return "Showing config summary";
    if (setting === "reset") return `Resetting ${value ?? "config setting"}`;
    return value != null ? `Setting ${setting} = ${value}` : `Inspecting ${setting}`;
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb, senderIds, getActions, getIsAdmin, select, selectMany }, { setting, value }) {
    if (!setting || setting === "list") {
      return getChatSettingsInfo(rootDb, chatId, { senderIds, getActions });
    }

    if (setting === "help") {
      const key = value?.trim();
      if (!key) {
        return "Usage: !c help <key>";
      }
      return describeConfigKey(rootDb, chatId, key, { getActions });
    }

    if (setting === "reset") {
      const key = value?.trim();
      if (!key) {
        return "Usage: !c reset <key>";
      }
      const isAdmin = getIsAdmin ? await getIsAdmin() : true;
      if (!isAdmin) {
        return "Only admins can change settings.";
      }
      return resetConfigValue(rootDb, chatId, key, { senderIds, getActions });
    }

    if (value === undefined || value === null) {
      const definition = getConfigKeyDefinition(setting);
      if (!definition) {
        return `Unknown config key \`${setting}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
      }
      const chat = await getChatOrThrow(rootDb, chatId);
      if (setting === "show" && typeof selectMany === "function") {
        const helpText = await describeConfigKey(rootDb, chatId, setting, { getActions, compact: true });
        const { options, currentIds } = getShowSelectManyOptions(chat);
        const selectedIds = await selectMany(
          helpText,
          options,
          { deleteOnSelect: true, currentIds },
        );
        if (selectedIds.length === 0) {
          return helpText;
        }
        const isAdmin = getIsAdmin ? await getIsAdmin() : true;
        if (!isAdmin) {
          return "Only admins can change settings.";
        }
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
          return "Unknown show control. Available: commands, thinking, tools, changes";
        }
        const nextVisibility = buildOutputVisibilityOverrides(selectedIds);
        await rootDb.sql`
          UPDATE chats
          SET output_visibility = ${JSON.stringify(nextVisibility)}::jsonb
          WHERE chat_id = ${chatId}
        `;
        return `Show set to ${formatOutputVisibility(nextVisibility)}.`;
      }
      const selectable = getSelectableOptions(definition, chat);
      if (selectable && typeof select === "function") {
        const helpText = await describeConfigKey(rootDb, chatId, setting, { getActions, compact: true });
        const chosen = await select(
          helpText,
          selectable.options,
          { deleteOnSelect: true, currentId: selectable.currentId },
        );
        if (chosen) {
          const isAdmin = getIsAdmin ? await getIsAdmin() : true;
          if (!isAdmin) {
            return "Only admins can change settings.";
          }
          return setConfigValue(rootDb, chatId, setting, chosen, { senderIds, getActions });
        }
        return helpText;
      }
      return describeConfigKey(rootDb, chatId, setting, { getActions });
    }

    const isAdmin = getIsAdmin ? await getIsAdmin() : true;
    if (!isAdmin) {
      return "Only admins can change settings.";
    }

    return setConfigValue(rootDb, chatId, setting, String(value), { senderIds, getActions });
  },
});
