import { normalizeCodexFileChanges } from "./codex-file-events.js";
import { extractCodexReasoningParts, extractCodexText, isCodexEventRecord, normalizeCodexUsage } from "./codex-event-utils.js";
import {
  extractCollabToolArguments,
  extractCollabToolOutput,
  extractCommandOutput,
  extractCommandText,
  extractPlanState,
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

  if (eventType === "turn.completed") {
    normalized.usage = normalizeCodexUsage(event, event);
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

  if ((eventType === "item.started" || eventType === "item.updated" || eventType === "item.completed") && itemType === "reasoning") {
    const id = typeof item.id === "string" ? item.id : null;
    if (id) {
      const contentSnapshot = extractCodexReasoningParts(item.content);
      const summarySnapshot = extractCodexReasoningParts(item.summary);
      const text = typeof item.text === "string" && item.text.length > 0 ? item.text : extractCodexText(item) ?? undefined;
      normalized.reasoningEvent = {
        itemId: id,
        status: eventType === "item.started"
          ? "started"
          : eventType === "item.updated" ? "updated" : "completed",
        summarySnapshot,
        contentSnapshot: contentSnapshot.length > 0
          ? contentSnapshot
          : text ? [text] : [],
      };
    }
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
    normalized.plan = extractPlanState(item) ?? undefined;
    return normalized;
  }

  if (eventType === "item.completed" && (itemType.includes("file") || itemType.includes("patch"))) {
    const fileChanges = normalizeCodexFileChanges(item);
    if (fileChanges.length === 1) {
      normalized.fileChange = fileChanges[0];
    } else if (fileChanges.length > 1) {
      normalized.fileChanges = fileChanges;
    }
    return normalized;
  }

  return normalized;
}
