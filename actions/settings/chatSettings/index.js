import { getChatOrThrow } from "../../../store.js";
import {
  CONFIG_KEYS,
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
      const multiSelectable = getMultiSelectableOptions(definition, chat);
      if (multiSelectable && typeof selectMany === "function") {
        const helpText = await describeConfigKey(rootDb, chatId, setting, { getActions, compact: true });
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
        return setConfigValue(rootDb, chatId, setting, selection.ids.join(" "), { senderIds, getActions });
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
