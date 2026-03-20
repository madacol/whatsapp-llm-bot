/**
 * Normalize Codex JSON events into the harness-level semantic events used by
 * the rest of the bot.
 */

import { extractCodexText, isCodexEventRecord } from "./codex-event-utils.js";
import { normalizeCodexFileChange } from "./codex-file-events.js";
export { extractCodexText } from "./codex-event-utils.js";

/**
 * @typedef {{
 *   command: string,
 *   status: "started" | "completed" | "failed",
 *   output?: string,
 * }} CodexCommandEvent
 */

/**
 * @typedef {{
 *   path: string,
 *   summary?: string,
 *   diff?: string,
 *   kind?: "add" | "delete" | "update",
 * }} CodexFileChangeEvent
 */

/**
 * @typedef {{
 *   sessionId: string | null,
 *   usage?: HarnessUsage,
 *   failureMessage?: string,
 *   commandEvent?: CodexCommandEvent,
 *   assistantText?: string,
 *   planText?: string,
 *   fileChange?: CodexFileChangeEvent,
 * }} NormalizedCodexEvent
 */

/**
 * Extract a session id from a Codex event when present.
 * @param {unknown} event
 * @returns {string | null}
 */
export function extractCodexSessionId(event) {
  if (!isCodexEventRecord(event)) {
    return null;
  }
  if (typeof event.thread_id === "string") {
    return event.thread_id;
  }
  if (typeof event.session_id === "string") {
    return event.session_id;
  }
  if (isCodexEventRecord(event.thread) && typeof event.thread.id === "string") {
    return event.thread.id;
  }
  if (isCodexEventRecord(event.item) && typeof event.item.thread_id === "string") {
    return event.item.thread_id;
  }
  if (isCodexEventRecord(event.item) && isCodexEventRecord(event.item.thread) && typeof event.item.thread.id === "string") {
    return event.item.thread.id;
  }
  return null;
}

/**
 * Build a short display string for command events.
 * @param {unknown} item
 * @returns {string | null}
 */
function extractCommandText(item) {
  if (!isCodexEventRecord(item)) {
    return null;
  }
  for (const key of ["command", "command_line", "cmd", "input"]) {
    if (typeof item[key] === "string" && item[key].length > 0) {
      return unwrapShellCommand(item[key]);
    }
  }
  const text = extractCodexText(item.command);
  return text ? unwrapShellCommand(text) : null;
}

/**
 * Codex command executions often report the shell wrapper that launched the
 * command. Strip that transport noise so the user sees the command the agent
 * actually intended to run.
 * @param {string} command
 * @returns {string}
 */
function unwrapShellCommand(command) {
  const match = command.match(/^(?:(?:\/usr\/bin\/env)\s+)?(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (!match) {
    return command;
  }
  const quote = match[1];
  const inner = match[2];
  if (quote === "\"") {
    return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return inner.replace(/'\\''/g, "'");
}

/**
 * Extract output text for command completion/failure events.
 * @param {unknown} item
 * @returns {string | undefined}
 */
function extractCommandOutput(item) {
  const text = extractCodexText(item);
  return text ?? undefined;
}

/**
 * Extract a file path from a Codex event item when present.
 * @param {unknown} item
 * @returns {string | null}
 */
function extractPlanText(item) {
  if (!isCodexEventRecord(item)) {
    return null;
  }
  if (Array.isArray(item.items)) {
    const lines = item.items
      .filter(isCodexEventRecord)
      .map((entry) => typeof entry.text === "string" ? entry.text : null)
      .filter((text) => typeof text === "string" && text.length > 0);
    if (lines.length > 0) {
      return lines.join("\n");
    }
  }
  return extractCodexText(item);
}

/**
 * Normalize a parsed Codex JSON event into the semantic event shape used by the
 * harness wrapper.
 * @param {unknown} event
 * @returns {NormalizedCodexEvent | null}
 */
export function normalizeCodexEvent(event) {
  if (!isCodexEventRecord(event)) {
    return null;
  }

  /** @type {NormalizedCodexEvent} */
  const normalized = {
    sessionId: extractCodexSessionId(event),
  };

  const eventType = typeof event.type === "string" ? event.type : null;
  const item = isCodexEventRecord(event.item) ? event.item : null;
  const itemType = item && typeof item.type === "string" ? item.type : null;
  const usage = isCodexEventRecord(event.usage) ? event.usage : null;

  if (eventType === "turn.completed") {
    normalized.usage = {
      promptTokens: typeof usage?.input_tokens === "number"
        ? usage.input_tokens
        : typeof event.input_tokens === "number" ? event.input_tokens : 0,
      completionTokens: typeof usage?.output_tokens === "number"
        ? usage.output_tokens
        : typeof event.output_tokens === "number" ? event.output_tokens : 0,
      cachedTokens: typeof usage?.cached_input_tokens === "number"
        ? usage.cached_input_tokens
        : typeof event.cached_input_tokens === "number" ? event.cached_input_tokens : 0,
      cost: 0,
    };
    return normalized;
  }

  if (eventType === "turn.failed" || eventType === "error") {
    normalized.failureMessage = extractCodexText(event) ?? "Codex run failed.";
    return normalized;
  }

  if (!item || !itemType) {
    return normalized;
  }

  if (eventType === "item.started" && itemType === "command_execution") {
    const command = extractCommandText(item);
    if (command) {
      normalized.commandEvent = { command, status: "started" };
    }
    return normalized;
  }

  if (eventType === "item.completed" && itemType === "command_execution") {
    const command = extractCommandText(item);
    if (command) {
      normalized.commandEvent = {
        command,
        status: "completed",
        output: extractCommandOutput(item),
      };
    }
    return normalized;
  }

  if (eventType === "item.failed" && itemType === "command_execution") {
    normalized.commandEvent = {
      command: extractCommandText(item) ?? "command",
      status: "failed",
      output: extractCommandOutput(item),
    };
    return normalized;
  }

  if (eventType === "item.completed" && itemType === "agent_message") {
    normalized.assistantText = extractCodexText(item) ?? undefined;
    return normalized;
  }

  if (eventType === "item.completed" && (itemType.includes("plan") || itemType === "todo_list")) {
    normalized.planText = extractPlanText(item) ?? undefined;
    return normalized;
  }

  if (eventType === "item.completed" && (itemType.includes("file") || itemType.includes("patch"))) {
    const fileChange = normalizeCodexFileChange(item);
    if (fileChange) {
      normalized.fileChange = fileChange;
    }
    return normalized;
  }

  return normalized;
}
