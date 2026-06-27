import { runChatSettingsInteraction } from "../chat-settings-service.js";

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
  return runChatSettingsInteraction(context, { setting, value });
}
