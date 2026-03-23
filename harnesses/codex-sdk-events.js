import { normalizeCodexFileChange } from "./codex-file-events.js";
import { extractCodexText, isCodexEventRecord } from "./codex-event-utils.js";
import {
  extractCollabToolArguments,
  extractCollabToolOutput,
  extractCommandOutput,
  extractCommandText,
  extractPlanText,
  extractToolResultOutput,
  normalizeCollabToolName,
} from "./codex-normalization-helpers.js";

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
 * Normalize a parsed Codex JSON event into the semantic event shape used by the
 * harness wrapper.
 * @param {unknown} event
 * @returns {import("./codex-events.js").NormalizedCodexEvent | null}
 */
export function normalizeCodexEvent(event) {
  if (!isCodexEventRecord(event)) {
    return null;
  }

  /** @type {import("./codex-events.js").NormalizedCodexEvent} */
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
      const output = extractToolResultOutput(item.result);
      normalized.toolEvent = {
        id,
        name,
        arguments: args,
        status: eventType === "item.started"
          ? "started"
          : eventType === "item.failed" || (isCodexEventRecord(item.error) && typeof item.error.message === "string")
            ? "failed"
            : "completed",
        ...(output ? { output } : {}),
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
      const output = extractCollabToolOutput(item.agents_states);
      normalized.toolEvent = {
        id,
        name,
        arguments: extractCollabToolArguments(item),
        status: eventType === "item.started"
          ? "started"
          : eventType === "item.failed"
            ? "failed"
            : "completed",
        ...(output ? { output } : {}),
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
      const output = eventType === "item.completed" ? extractPlanText(item) ?? undefined : undefined;
      normalized.toolEvent = {
        id,
        name: "update_plan",
        arguments: { items },
        status: eventType === "item.started" ? "started" : "completed",
        ...(output ? { output } : {}),
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
