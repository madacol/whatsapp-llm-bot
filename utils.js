import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { ensureChatDirs, getChatRootDir, getChatWorkspaceDir } from "./chat-paths.js";
import config from "./config.js";
import { formatCommandInspectText as formatWhatsappCommandInspectText } from "./presentation/whatsapp.js";

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
 * Build a collision-safe readable workspace link name.
 * @param {string} chatId
 * @param {string | null | undefined} chatName
 * @param {string} linksDir
 * @param {string} targetPath
 * @returns {string}
 */
function getWorkspaceLinkName(chatId, chatName, linksDir, targetPath) {
  const sanitizedChatName = sanitizeWorkspaceName(chatName);
  if (!sanitizedChatName) return chatId;

  const preferredName = sanitizedChatName;
  const preferredPath = resolve(linksDir, preferredName);
  if (!existsSync(preferredPath) || isSymlinkTo(preferredPath, targetPath)) {
    return preferredName;
  }

  return `${sanitizedChatName}${WORKSPACE_NAME_DELIMITER}${chatId}`;
}

/**
 * @param {string} linkPath
 * @param {string} targetPath
 * @returns {boolean}
 */
function isSymlinkTo(linkPath, targetPath) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    return resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath;
  } catch {
    return false;
  }
}

/**
 * @param {string} linkPath
 * @param {string} targetPath
 * @returns {void}
 */
function createDirectorySymlinkIfMissing(linkPath, targetPath) {
  if (linkPath === targetPath) return;
  if (existsSync(linkPath)) return;
  symlinkSync(targetPath, linkPath, "dir");
}

/**
 * Return (and lazily create) the canonical working directory for a chat.
 * Falls back to `explicitCwd` when set, otherwise `~/chat/<chatId>/workspace`.
 * Human-friendly names are represented as symlinks under `~/chat-workspaces`.
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

  const workspaceDir = getChatWorkspaceDir(chatId);
  mkdirSync(getChatRootDir(chatId), { recursive: true });
  ensureChatDirs(chatId);

  const linkPath = resolve(workspacesDir, getWorkspaceLinkName(chatId, chatName, workspacesDir, workspaceDir));
  createDirectorySymlinkIfMissing(linkPath, workspaceDir);
  return workspaceDir;
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
  const inspectMode = toolName === "Bash" ? "bash" : "plain";
  return formatWhatsappCommandInspectText(command, output, inspectMode);
}

/**
 * Extract a human-readable message from an unknown error value.
 * @param {unknown} err
 * @returns {string}
 */
export function errorToString(err) {
  return err instanceof Error ? err.message : String(err);
}
