/**
 * Shortens a tool call ID to characters 6–11 (skipping the common prefix)
 * @param {string} toolCallId
 * @returns {string} Shortened tool call ID
 */
export function shortenToolId(toolCallId) {
  return toolCallId ? toolCallId.substring(6, 12) : "unknown";
}
