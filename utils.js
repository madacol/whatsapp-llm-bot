import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Workspaces live outside the bot project so the SDK's upward CLAUDE.md
 *  traversal never reaches the bot's own CLAUDE.md / settings. */
const WORKSPACES_DIR = resolve(homedir(), "chat-workspaces");

/**
 * Return (and lazily create) a unique working directory for a chat.
 * Falls back to `explicitCwd` when set, otherwise `~/chat-workspaces/<chatId>/`.
 *
 * The directory is outside the bot's project tree so the SDK treats each
 * workspace as an independent project root (no inherited CLAUDE.md).
 * @param {string} chatId
 * @param {string | null | undefined} [explicitCwd]
 * @returns {string} Absolute path to the chat's working directory
 */
export function getChatWorkDir(chatId, explicitCwd) {
  if (explicitCwd) return resolve(explicitCwd);
  const dir = resolve(WORKSPACES_DIR, chatId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
 * Format a millisecond duration as a human-readable relative time string (e.g. "5m ago", "2h ago", "3d ago").
 * @param {number} ms - Duration in milliseconds
 * @param {string} [suffix="ago"] - Suffix to append
 * @returns {string}
 */
export function formatRelativeTime(ms, suffix = "ago") {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ${suffix}`;
  if (min < 1440) return `${Math.round(min / 60)}h ${suffix}`;
  return `${Math.round(min / 1440)}d ${suffix}`;
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
