import { formatChatSettingsUsage } from "../chat-commands.js";
import { getRootDb, getChatDb } from "../db.js";
import { getChatOrThrow } from "../store.js";
import {
  CONFIG_KEYS,
  describeConfigKey,
  getConfigKeyDefinition,
  getChatSettingsInfo,
  getMultiSelectableOptions,
  getSelectableOptions,
  resetConfigValue,
  setConfigValue,
} from "../chat-settings-service.js";

export const CHAT_SETTINGS_COMMAND_PARAMETERS = /** @type {CommandParametersSchema} */ ({
  type: "object",
  properties: {
    setting: { type: "string" },
    value: { type: "string" },
  },
});

/**
 * @param {{
 *   chatId: string,
 *   senderIds?: string[],
 *   getIsAdmin?: ExecuteActionContext["getIsAdmin"],
 *   select?: ExecuteActionContext["select"],
 *   selectMany?: ExecuteActionContext["selectMany"],
 *   rootDb?: import("../sqlite-db.js").SqliteDb,
 * }} context
 * @param {{ setting?: string, value?: string }} params
 * @returns {Promise<string>}
 */
export async function runChatSettingsCommand(context, { setting, value }) {
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
