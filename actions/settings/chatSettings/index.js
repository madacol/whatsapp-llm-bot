import { CHAT_SETTINGS_COMMAND, formatChatSettingsCommand, formatChatSettingsUsage } from "../../../chat-commands.js";
import { getChatOrThrow } from "../../../store.js";
import { getChatDb } from "../../../db.js";
import {
  CONFIG_KEYS,
  CONFIG_KEY_INPUTS,
  describeConfigKey,
  getConfigKeyDefinition,
  getChatSettingsInfo,
  getMultiSelectableOptions,
  getSelectableOptions,
  resetConfigValue,
  setConfigValue,
} from "./_service.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "chat_settings",
  command: CHAT_SETTINGS_COMMAND,
  description:
    `Inspect and change chat settings. Use \`${formatChatSettingsCommand()}\`, \`${formatChatSettingsCommand("<key>")}\`, \`${formatChatSettingsCommand("help <key>")}\`, \`${formatChatSettingsCommand("<key> <value>")}\`, or \`${formatChatSettingsCommand("reset <key>")}\`. Keys: ${CONFIG_KEYS.join(", ")}.`,
  parameters: {
    type: "object",
    properties: {
      setting: {
        type: "string",
        enum: ["help", "list", "reset", ...CONFIG_KEY_INPUTS],
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
    useChatDb: true,
  },
  action_fn: async function ({ chatId, rootDb, chatDb, senderIds, getActions, getIsAdmin, select, selectMany }, { setting, value }) {
    const db = chatDb ?? rootDb;
    const serviceExtra = { senderIds, getActions, rootDb, getChatDb: chatDb ? getChatDb : undefined };
    if (!setting || setting === "list") {
      return getChatSettingsInfo(db, chatId, serviceExtra);
    }

    if (setting === "help") {
      const key = value?.trim();
      if (!key) {
        return formatChatSettingsUsage("help <key>");
      }
      return describeConfigKey(db, chatId, key, { getActions, rootDb, getChatDb });
    }

    if (setting === "reset") {
      const key = value?.trim();
      if (!key) {
        return formatChatSettingsUsage("reset <key>");
      }
      const isAdmin = getIsAdmin ? await getIsAdmin() : true;
      if (!isAdmin) {
        return "Only admins can change settings.";
      }
      return resetConfigValue(db, chatId, key, serviceExtra);
    }

    if (value === undefined || value === null) {
      const definition = getConfigKeyDefinition(setting);
      if (!definition) {
        return `Unknown config key \`${setting}\`.\nAvailable keys: ${CONFIG_KEYS.join(", ")}`;
      }
      const chat = await getChatOrThrow(db, chatId);
      const multiSelectable = getMultiSelectableOptions(definition, chat);
      if (multiSelectable && typeof selectMany === "function") {
        const helpText = await describeConfigKey(db, chatId, setting, { getActions, compact: true, rootDb, getChatDb });
        const selection = await selectMany(
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
        const isAdmin = getIsAdmin ? await getIsAdmin() : true;
        if (!isAdmin) {
          return "Only admins can change settings.";
        }
        return setConfigValue(db, chatId, setting, selection.ids.join(" "), serviceExtra);
      }
      const selectable = getSelectableOptions(definition, chat);
      if (selectable && typeof select === "function") {
        const helpText = await describeConfigKey(db, chatId, setting, { getActions, compact: true, rootDb, getChatDb });
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
          return setConfigValue(db, chatId, setting, chosen, serviceExtra);
        }
        return helpText;
      }
      return describeConfigKey(db, chatId, setting, { getActions, rootDb, getChatDb });
    }

    const isAdmin = getIsAdmin ? await getIsAdmin() : true;
    if (!isAdmin) {
      return "Only admins can change settings.";
    }

    return setConfigValue(db, chatId, setting, String(value), serviceExtra);
  },
});
