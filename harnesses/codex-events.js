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
 *   id: string,
 *   name: string,
 *   arguments: Record<string, unknown>,
 *   status: "started" | "completed" | "failed",
 *   output?: string,
 * }} CodexToolEvent
 */

/**
 * @typedef {{
 *   path: string,
 *   summary?: string,
 *   diff?: string,
 *   kind?: "add" | "delete" | "update",
 *   oldText?: string,
 *   newText?: string,
 * }} CodexFileChangeEvent
 */

/**
 * @typedef {{
 *   sessionId: string | null,
 *   usage?: HarnessUsage,
 *   failureMessage?: string,
 *   commandEvent?: CodexCommandEvent,
 *   toolEvent?: CodexToolEvent,
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
  const match = command.match(
    /^(?:(?:\/usr\/bin\/env)\s+)?(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc(?:\s+(['"])([\s\S]*)\1|\s+([\s\S]+))$/,
  );
  if (!match) {
    return command;
  }
  const quote = match[1];
  const inner = match[2] ?? match[3] ?? "";
  if (!quote) {
    return inner;
  }
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
  if (isCodexEventRecord(item) && typeof item.aggregated_output === "string") {
    return item.aggregated_output;
  }
  const text = extractCodexText(item);
  return text ?? undefined;
}

/**
 * Extract text from a completed MCP tool result when possible.
 * @param {unknown} result
 * @returns {string | undefined}
 */
function extractToolResultOutput(result) {
  if (!isCodexEventRecord(result)) {
    return undefined;
  }

  if (Array.isArray(result.content)) {
    const textParts = result.content
      .map((block) => extractCodexText(block))
      .filter((text) => typeof text === "string" && text.length > 0);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  const structured = extractCodexText(result.structured_content);
  if (structured) {
    return structured;
  }

  const serializedStructured = serializeStructuredToolResult(result.structured_content);
  if (serializedStructured) {
    return serializedStructured;
  }

  return extractCodexText(result) ?? serializeStructuredToolResult(result);
}

/**
 * Fall back to JSON for structured tool results that do not expose a text-ish
 * field. This keeps inspect useful for tools like the web MCP, which often
 * returns records/arrays of results instead of text blocks.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function serializeStructuredToolResult(value) {
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value) || isCodexEventRecord(value)) {
    return JSON.stringify(value, null, 2);
  }
  return undefined;
}

/**
 * Extract text from collab tool state when possible.
 * @param {unknown} states
 * @returns {string | undefined}
 */
function extractCollabToolOutput(states) {
  if (!isCodexEventRecord(states)) {
    return undefined;
  }

  const messages = Object.values(states)
    .filter(isCodexEventRecord)
    .map((state) => typeof state.message === "string" ? state.message : null)
    .filter((message) => typeof message === "string" && message.length > 0);

  return messages.length > 0 ? messages.join("\n") : undefined;
}

/**
 * @param {string} toolName
 * @returns {string}
 */
function normalizeCollabToolName(toolName) {
  switch (toolName) {
    case "wait":
      return "wait_agent";
    default:
      return toolName;
  }
}

/**
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function extractCollabToolArguments(item) {
  /** @type {Record<string, unknown>} */
  const args = {};

  if (typeof item.prompt === "string" && item.prompt.length > 0) {
    args.prompt = item.prompt;
  }
  if (Array.isArray(item.receiver_thread_ids) && item.receiver_thread_ids.length > 0) {
    args.receiver_thread_ids = item.receiver_thread_ids;
  }
  if (Array.isArray(item.agents_states) && item.agents_states.length > 0) {
    args.agents_states = item.agents_states;
  }

  return args;
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

  if (itemType === "mcp_tool_call") {
    const id = typeof item.id === "string" ? item.id : null;
    const name = typeof item.tool === "string" ? item.tool : null;
    const args = isCodexEventRecord(item.arguments) ? item.arguments : {};
    if (id && name) {
      normalized.toolEvent = {
        id,
        name,
        arguments: args,
        status: eventType === "item.started"
          ? "started"
          : eventType === "item.failed" || (isCodexEventRecord(item.error) && typeof item.error.message === "string")
            ? "failed"
            : "completed",
        ...(extractToolResultOutput(item.result) ? { output: extractToolResultOutput(item.result) } : {}),
        ...(isCodexEventRecord(item.error) && typeof item.error.message === "string"
          ? { output: item.error.message }
          : {}),
      };
    }
    return normalized;
  }

  if (itemType === "collab_tool_call") {
    const id = typeof item.id === "string" ? item.id : null;
    const name = typeof item.tool === "string" ? normalizeCollabToolName(item.tool) : null;
    if (id && name) {
      normalized.toolEvent = {
        id,
        name,
        arguments: extractCollabToolArguments(item),
        status: eventType === "item.started"
          ? "started"
          : eventType === "item.failed"
            ? "failed"
            : "completed",
        ...(extractCollabToolOutput(item.agents_states) ? { output: extractCollabToolOutput(item.agents_states) } : {}),
      };
    }
    return normalized;
  }

  if (itemType === "web_search") {
    const id = typeof item.id === "string" ? item.id : null;
    const query = typeof item.query === "string" ? item.query : null;
    if (id && query) {
      normalized.toolEvent = {
        id,
        name: "WebSearch",
        arguments: { query },
        status: eventType === "item.started" ? "started" : "completed",
      };
    }
    return normalized;
  }

  if (itemType === "todo_list") {
    const id = typeof item.id === "string" ? item.id : null;
    const items = Array.isArray(item.items) ? item.items : null;
    if (id && items) {
      normalized.toolEvent = {
        id,
        name: "update_plan",
        arguments: { items },
        status: eventType === "item.started" ? "started" : "completed",
        ...(eventType === "item.completed"
          ? { output: extractPlanText(item) ?? undefined }
          : {}),
      };
    }
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
