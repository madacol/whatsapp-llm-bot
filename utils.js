import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import config from "./config.js";

/** Workspaces live outside the bot project so the SDK's upward CLAUDE.md
 *  traversal never reaches the bot's own CLAUDE.md / settings. */
const DEFAULT_WORKSPACES_DIR = resolve(homedir(), "chat-workspaces");

/** @returns {string} */
function getWorkspacesDir() {
  return config.workspaces_dir ? resolve(config.workspaces_dir) : DEFAULT_WORKSPACES_DIR;
}

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
  const dir = resolve(getWorkspacesDir(), chatId);
  mkdirSync(dir, { recursive: true });
  return dir;
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

/**
 * Enrich a tool message with WhatsApp tracking metadata from the editor.
 * Used by both harnesses to attach wa_key_id, tool_name, and wa_msg_is_image.
 * @param {ToolMessage} base
 * @param {MessageEditor | undefined} editor
 * @param {string} toolName
 * @returns {ToolMessage}
 */
export function withEditorMeta(base, editor, toolName) {
  return {
    ...base,
    ...(editor?.keyId && { wa_key_id: editor.keyId }),
    ...(toolName && { tool_name: toolName }),
    ...(editor?.isImage && { wa_msg_is_image: true }),
  };
}

/**
 * Extract a human-readable message from an unknown error value.
 * @param {unknown} err
 * @returns {string}
 */
export function errorToString(err) {
  return err instanceof Error ? err.message : String(err);
}
