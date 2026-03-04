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

/**
 * Create a branded HtmlContent object that signals "serve this as an HTML page".
 * @param {string} content - The HTML content
 * @param {string} [title] - Optional page title
 * @returns {HtmlContent}
 */
export function html(content, title) {
  return { __brand: "html", html: content, title };
}

/**
 * Type guard: checks whether a value is a branded HtmlContent object.
 * @param {unknown} value
 * @returns {value is HtmlContent}
 */
export function isHtmlContent(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    /** @type {{__brand?: unknown}} */ (value).__brand === "html" &&
    typeof /** @type {{html?: unknown}} */ (value).html === "string"
  );
}

/**
 * Create a ToolMessage with a single text content block.
 * @param {string} toolId
 * @param {string} text
 * @returns {ToolMessage}
 */
export function createToolMessage(toolId, text) {
  return { role: "tool", tool_id: toolId, content: [{ type: "text", text }] };
}
