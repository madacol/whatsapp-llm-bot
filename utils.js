import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import config from "./config.js";
import { classifyCommandActivity } from "./tool-display.js";

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
 * Build inspect text for a shell command, always showing the command first and
 * then the formatted command result below it.
 * @param {string} command
 * @param {string | undefined} output
 * @param {string} [toolName]
 * @returns {string}
 */
export function formatCommandInspectText(command, output, toolName) {
  const inspectToolName = inferInspectToolName(command, toolName);
  const body = output != null && output.length > 0
    ? formatToolResultForInspect(output, inspectToolName)
    : "_no output_";
  return [
    "```bash",
    command,
    "```",
    "",
    body,
  ].join("\n");
}

/**
 * @param {string} command
 * @param {string | undefined} toolName
 * @returns {string | undefined}
 */
function inferInspectToolName(command, toolName) {
  if (toolName !== "Bash") {
    return toolName;
  }

  const activity = classifyCommandActivity(command, undefined);
  if (!activity) {
    return toolName;
  }

  switch (activity.title) {
    case "Search":
      return "Grep";
    case "Read":
      return "Read";
    case "List":
      return "Glob";
    default:
      return toolName;
  }
}


/**
 * Extract the human-readable output from a tool result text.
 * Formats output differently depending on the tool:
 * - Bash: extracts stdout/stderr from JSON
 * - Grep: groups matching lines by file path
 * - Glob: adds file count summary
 * - Others: returns as-is
 * @param {string} text
 * @param {string} [toolName]
 * @returns {string}
 */
function formatToolResultForInspect(text, toolName) {
  // Bash: parse {stdout, stderr} JSON
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "stdout" in parsed) {
      /** @type {string[]} */
      const parts = [];
      if (typeof parsed.stdout === "string" && parsed.stdout.trim()) {
        parts.push(parsed.stdout.trim());
      }
      if (typeof parsed.stderr === "string" && parsed.stderr.trim()) {
        parts.push(`_stderr:_\n${parsed.stderr.trim()}`);
      }
      if (parts.length > 0) return parts.join("\n\n");
      return "_no output_";
    }
  } catch {
    // Not JSON — continue to tool-specific formatting
  }

  if (toolName === "Grep") {
    return formatGrepForInspect(text);
  }
  if (toolName === "Glob") {
    return formatGlobForInspect(text);
  }
  if (toolName === "Read") {
    return formatReadForInspect(text);
  }

  return text;
}

/**
 * Format Grep output: group matching lines under file path headers.
 * Input format: `filepath:lineNum:content` or `filepath:lineNum-content` per line.
 * @param {string} text
 * @returns {string}
 */
function formatGrepForInspect(text) {
  const lines = text.split("\n");
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  const grepLinePattern = /^(.+?):(\d+)([:-])(.*)$/;

  for (const line of lines) {
    const m = line.match(grepLinePattern);
    if (m) {
      const [, filePath, lineNum, , content] = m;
      if (!groups.has(filePath)) groups.set(filePath, []);
      groups.get(filePath)?.push(`${lineNum}: ${content.trim()}`);
    } else if (line.trim()) {
      // Non-matching line (e.g. separator, header) — keep as-is
      const key = "__other__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(line);
    }
  }

  if (groups.size === 0) return text;

  /** @type {string[]} */
  const parts = [];
  for (const [filePath, fileLines] of groups) {
    if (filePath === "__other__") {
      parts.push(fileLines.join("\n"));
    } else {
      parts.push(`*${filePath}*\n\`\`\`\n${fileLines.join("\n")}\n\`\`\``);
    }
  }
  return parts.join("\n\n");
}

/**
 * Format Glob output: add file count summary above the path list.
 * @param {string} text
 * @returns {string}
 */
function formatGlobForInspect(text) {
  const paths = text.split("\n").filter(l => l.trim());
  if (paths.length === 0) return "_no files_";
  return `_${paths.length} file${paths.length === 1 ? "" : "s"}_\n\`\`\`\n${paths.join("\n")}\n\`\`\``;
}

/**
 * Format Read output: wrap file content in a code block.
 * Strips the `  N→` / `  N\t` line number prefixes added by the SDK.
 * @param {string} text
 * @returns {string}
 */
function formatReadForInspect(text) {
  const stripped = text.replace(/^\s*\d+[\t→]\s?/gm, "");
  return `\`\`\`\n${stripped}\n\`\`\``;
}

/**
 * Register a 👁 react-to-inspect callback on a message handle.
 * When the user reacts with 👁, the tool-call message is edited
 * to show the full text result (truncated at 3000 chars).
 * @param {MessageHandle} handle
 * @param {string} summary - display header (e.g. "*Bash*  _description_" or "*Edit*  `file.js`")
 * @param {ToolMessage} toolMessage
 * @param {string} [toolName] - tool name for format-specific display
 * @param {string} [inspectText] - preformatted inspect body; bypasses default formatting
 */
export function registerInspectHandler(handle, summary, toolMessage, toolName, inspectText) {
  if (!handle.keyId) return;
  handle.onReaction((emoji) => {
    if (!emoji.startsWith("👁")) return;
    const rawText = toolMessage.content
      .filter(b => b.type === "text").map(b => /** @type {TextContentBlock} */ (b).text).join("\n");
    const text = inspectText ?? formatToolResultForInspect(rawText, toolName);
    const MAX = 3000;
    const display = text.length <= MAX ? text
      : text.slice(0, MAX) + `\n\n_… truncated (${text.length.toLocaleString()} chars total)_`;
    handle.edit(`${summary}\n\n${display}`);
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
