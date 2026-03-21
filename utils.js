import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import config from "./config.js";
import { buildCommandPresentation } from "./tool-presentation-model.js";
import { formatCommandInspectText as formatWhatsappCommandInspectText } from "./whatsapp/tool-presenter.js";

/** Workspaces live outside the bot project so the SDK's upward CLAUDE.md
 *  traversal never reaches the bot's own CLAUDE.md / settings. */
const DEFAULT_WORKSPACES_DIR = resolve(homedir(), "chat-workspaces");
const WORKSPACE_NAME_DELIMITER = "--";
const MAX_WORKSPACE_NAME_PREFIX_LENGTH = 80;
/** @type {string | null} */
let testingWorkspacesDir = null;
let registeredTestingWorkspacesCleanup = false;

/** @returns {string} */
function getWorkspacesDir() {
  if (config.workspaces_dir) {
    return resolve(config.workspaces_dir);
  }
  if (process.env.TESTING) {
    return getTestingWorkspacesDir();
  }
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * Keep test-created workspaces out of `~/chat-workspaces` so the real
 * workspace root only reflects actual chats.
 * @returns {string}
 */
function getTestingWorkspacesDir() {
  if (!testingWorkspacesDir) {
    testingWorkspacesDir = mkdtempSync(resolve(tmpdir(), "whatsapp-llm-bot-workspaces-"));
  }
  if (!registeredTestingWorkspacesCleanup) {
    process.once("exit", () => {
      if (testingWorkspacesDir) {
        rmSync(testingWorkspacesDir, { recursive: true, force: true });
      }
    });
    registeredTestingWorkspacesCleanup = true;
  }
  return testingWorkspacesDir;
}

/**
 * Turn a chat title into a readable filesystem-safe prefix.
 * @param {string | null | undefined} chatName
 * @returns {string}
 */
function sanitizeWorkspaceName(chatName) {
  if (typeof chatName !== "string") return "";
  return chatName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WORKSPACE_NAME_PREFIX_LENGTH)
    .trim();
}

/**
 * Build the preferred workspace directory name for a chat.
 * The raw chat ID stays in the suffix so the path remains stable and unique.
 * @param {string} chatId
 * @param {string | null | undefined} chatName
 * @returns {string}
 */
function getWorkspaceDirName(chatId, chatName) {
  const sanitizedChatName = sanitizeWorkspaceName(chatName);
  return sanitizedChatName
    ? `${sanitizedChatName}${WORKSPACE_NAME_DELIMITER}${chatId}`
    : chatId;
}

/**
 * Reuse an already-named workspace so callers without chat metadata still land
 * in the same directory as the main chat run.
 * @param {string} workspacesDir
 * @param {string} chatId
 * @returns {string | null}
 */
function findNamedWorkspaceDir(workspacesDir, chatId) {
  const suffix = `${WORKSPACE_NAME_DELIMITER}${chatId}`;
  if (!existsSync(workspacesDir)) return null;
  for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(suffix)) {
      return resolve(workspacesDir, entry.name);
    }
  }
  return null;
}

/**
 * Return (and lazily create) a unique working directory for a chat.
 * Falls back to `explicitCwd` when set, otherwise
 * `~/chat-workspaces/<chat-name>--<chatId>/` when a title is available or
 * `~/chat-workspaces/<chatId>/` as a fallback.
 *
 * The directory is outside the bot's project tree so the SDK treats each
 * workspace as an independent project root (no inherited CLAUDE.md).
 * @param {string} chatId
 * @param {string | null | undefined} [explicitCwd]
 * @param {string | null | undefined} [chatName]
 * @returns {string} Absolute path to the chat's working directory
 */
export function getChatWorkDir(chatId, explicitCwd, chatName) {
  if (explicitCwd) return resolve(explicitCwd);
  const workspacesDir = getWorkspacesDir();
  mkdirSync(workspacesDir, { recursive: true });

  const existingNamedDir = findNamedWorkspaceDir(workspacesDir, chatId);
  if (existingNamedDir) return existingNamedDir;

  const legacyDir = resolve(workspacesDir, chatId);
  const dir = resolve(workspacesDir, getWorkspaceDirName(chatId, chatName));

  if (dir !== legacyDir && existsSync(legacyDir) && !existsSync(dir)) {
    renameSync(legacyDir, dir);
    return dir;
  }

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
 * Build inspect text for a shell command, always showing the command first and
 * then the adapter-formatted command result below it.
 * @param {string} command
 * @param {string | undefined} output
 * @param {string} [toolName]
 * @returns {string}
 */
export function formatCommandInspectText(command, output, toolName) {
  const presentation = buildCommandPresentation(command, undefined);
  const inspectMode = toolName === "Bash" ? presentation.inspectMode : "plain";
  return formatWhatsappCommandInspectText(command, output, inspectMode);
}

/**
 * Register a 👁 react-to-inspect callback on a message handle.
 * When the user reacts with 👁, the tool-call message is edited
 * to show the full text result (truncated at 3000 chars).
 * @param {MessageHandle} handle
 * @param {string} summary - display header (e.g. "*Bash*  _description_" or "*Edit*  `file.js`")
 * @param {ToolMessage} toolMessage
 * @param {string} [_toolName] - reserved for call-site compatibility
 * @param {string} [inspectText] - preformatted inspect body; bypasses default formatting
 */
export function registerInspectHandler(handle, summary, toolMessage, _toolName, inspectText) {
  if (!handle.keyId) return;
  handle.onReaction((emoji) => {
    if (!emoji.startsWith("👁")) return;
    const rawText = toolMessage.content
      .filter(b => b.type === "text").map(b => /** @type {TextContentBlock} */ (b).text).join("\n");
    const text = inspectText ?? rawText;
    handle.edit(formatInspectEditText(summary, text));
  });
}

/**
 * Format inspect text for editing into a WhatsApp message with truncation.
 * @param {string} summary
 * @param {string} text
 * @returns {string}
 */
export function formatInspectEditText(summary, text) {
  const MAX = 3000;
  const display = text.length <= MAX ? text
    : text.slice(0, MAX) + `\n\n_… truncated (${text.length.toLocaleString()} chars total)_`;
  return `${summary}\n\n${display}`;
}

/**
 * Register a 👁 callback whose inspect payload can change over time.
 * @param {MessageHandle} handle
 * @param {() => { summary: string, text: string }} getState
 */
export function registerDynamicInspectHandler(handle, getState) {
  if (!handle.keyId) return;
  handle.onReaction((emoji) => {
    if (!emoji.startsWith("👁")) return;
    const { summary, text } = getState();
    handle.edit(formatInspectEditText(summary, text));
  });
}

/**
 * Extract a human-readable message from an unknown error value.
 * @param {unknown} err
 * @returns {string}
 */
export function errorToString(err) {
  return err instanceof Error ? err.message : String(err);
}
