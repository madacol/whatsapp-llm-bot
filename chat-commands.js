export const CHAT_SETTINGS_COMMAND = "s";
export const CANCEL_COMMAND = "c";

/**
 * @param {string} command
 * @param {string} [args]
 * @returns {string}
 */
export function formatBangCommand(command, args) {
  return args ? `!${command} ${args}` : `!${command}`;
}

/**
 * @param {string} [args]
 * @returns {string}
 */
export function formatChatSettingsCommand(args) {
  return formatBangCommand(CHAT_SETTINGS_COMMAND, args);
}

/**
 * @returns {string}
 */
export function formatCancelCommand() {
  return formatBangCommand(CANCEL_COMMAND);
}

/**
 * @param {string} [suffix]
 * @returns {string}
 */
export function formatChatSettingsUsage(suffix) {
  return suffix
    ? `Usage: ${formatChatSettingsCommand(suffix)}`
    : `Usage: ${formatChatSettingsCommand()}`;
}
