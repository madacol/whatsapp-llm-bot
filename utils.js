/**
 * Shortens a tool call ID to its first 6 characters
 * @param {string} toolCallId
 * @returns {string} Shortened tool call ID
 */
export function shortenToolId(toolCallId) {
    return toolCallId ? toolCallId.substring(6, 12) : 'unknown';
}