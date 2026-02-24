/**
 * Shortens a tool call ID to characters 6–11 (skipping the common prefix)
 * @param {string} toolCallId
 * @returns {string} Shortened tool call ID
 */
export function shortenToolId(toolCallId) {
  return toolCallId ? toolCallId.substring(6, 12) : "unknown";
}

/**
 * Format a timestamp for display.
 * @param {Date} date
 * @returns {string}
 */
export function formatTime(date) {
  return date.toLocaleString("en-EN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
