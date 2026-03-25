import { getChatOrThrow } from "../../../store.js";
import {
  SETTINGS,
  getSelectableOptions,
  getChatSettingsInfo,
  getChatSetting,
  setChatSetting,
} from "./_service.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "chat_settings",
  command: "config",
  description:
    `Get or set chat settings. Available settings: ${SETTINGS.join(", ")}. Omit value to see current setting.`,
  parameters: {
    type: "object",
    properties: {
      setting: {
        type: "string",
        enum: SETTINGS,
        description: "The setting to get or set",
      },
      value: {
        type: "string",
        description: "The value to set (omit to get current value)",
      },
    },
    required: ["setting"],
  },
  formatToolCall: ({ setting, value }) =>
    value != null ? `Setting ${setting} = ${value}` : `Getting ${setting}`,
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
  },
  action_fn: async function ({ chatId, rootDb, senderIds, getActions, getIsAdmin, select }, { setting, value }) {
    if (!setting || !SETTINGS.includes(setting)) {
      return getChatSettingsInfo(rootDb, chatId, { senderIds, getActions });
    }

    if (value === undefined || value === null) {
      const chat = await getChatOrThrow(rootDb, chatId);
      const selectable = getSelectableOptions(setting, chat);
      if (selectable && typeof select === "function") {
        const chosen = await select(
          `Choose value for *${setting}*`,
          selectable.options,
          { deleteOnSelect: true, currentId: selectable.currentId },
        );
        if (chosen) {
          const isAdmin = getIsAdmin ? await getIsAdmin() : true;
          if (!isAdmin) return "Only admins can change settings.";
          return setChatSetting(rootDb, chatId, setting, chosen, { senderIds, getActions });
        }
      }
      return getChatSetting(rootDb, chatId, setting, { getActions });
    }

    const isAdmin = getIsAdmin ? await getIsAdmin() : true;
    if (!isAdmin) {
      return "Only admins can change settings.";
    }

    return setChatSetting(rootDb, chatId, setting, String(value), { senderIds, getActions });
  },
});
