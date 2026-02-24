/**
 * Shortens a tool call ID to characters 6–11 (skipping the common prefix)
 * @param {string} toolCallId
 * @returns {string} Shortened tool call ID
 */
export function shortenToolId(toolCallId) {
  return toolCallId ? toolCallId.substring(6, 12) : "unknown";
}

/**
 * Truncate a string to maxLen, appending a summary of omitted content.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateWithSummary(str, maxLen) {
  if (str.length <= maxLen) return str;
  const remaining = str.length - maxLen;
  const remainingLines = str.slice(maxLen).split("\n").length - 1;
  const suffix = remainingLines > 0
    ? `… +${remaining} chars, ${remainingLines} lines`
    : `… +${remaining} chars`;
  return str.slice(0, maxLen) + suffix;
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
