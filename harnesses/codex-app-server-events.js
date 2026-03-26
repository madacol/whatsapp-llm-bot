import { normalizeCodexFileChanges } from "./codex-file-events.js";
import { extractCodexText, isCodexEventRecord, normalizeCodexUsage } from "./codex-event-utils.js";
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
 * Normalize a Codex App Server JSON-RPC message into the semantic event shape
 * used by the harness wrapper.
 * @param {unknown} message
 * @returns {import("./codex-events.js").NormalizedCodexEvent | null}
 */
export function normalizeCodexAppServerEvent(message) {
  if (!isCodexEventRecord(message)) {
    return null;
  }

  const method = typeof message.method === "string" ? message.method : null;
  const params = isCodexEventRecord(message.params) ? message.params : null;
  if (!method || !params) {
    return null;
  }

  /** @type {import("./codex-events.js").NormalizedCodexEvent} */
  const normalized = {
    sessionId: typeof params.threadId === "string"
      ? params.threadId
      : isCodexEventRecord(params.thread) && typeof params.thread.id === "string"
        ? params.thread.id
        : null,
  };

  if (method === "error") {
    normalized.failureMessage = extractCodexText(params.error) ?? extractCodexText(params) ?? "Codex run failed.";
    return normalized;
  }

  if (method === "turn/completed") {
    const turn = isCodexEventRecord(params.turn) ? params.turn : null;
    const turnStatus = typeof turn?.status === "string" ? turn.status : null;
    if (turnStatus === "failed") {
      normalized.failureMessage = extractCodexText(turn?.error) ?? "Codex run failed.";
      return normalized;
    }
    return normalized;
  }

  if (method === "turn/plan/updated") {
    const plan = Array.isArray(params.plan) ? params.plan : [];
    const lines = plan
      .filter(isCodexEventRecord)
      .map((entry) => typeof entry.step === "string" ? entry.step : null)
      .filter((line) => typeof line === "string" && line.length > 0);
    if (typeof params.explanation === "string" && params.explanation.length > 0) {
      lines.unshift(params.explanation);
    }
    normalized.planText = lines.join("\n") || undefined;
    return normalized;
  }

  if (method === "thread/tokenUsage/updated") {
    normalized.usage = normalizeCodexUsage(params);
    return normalized;
  }

  if (method !== "item/started" && method !== "item/completed") {
    return normalized;
  }

  const item = isCodexEventRecord(params.item) ? params.item : null;
  const itemType = item && typeof item.type === "string" ? item.type : null;
  if (!item || !itemType) {
    return normalized;
  }

  if (itemType === "commandExecution") {
    const command = extractCommandText(item);
    if (command) {
      const output = extractCommandOutput(item);
      normalized.commandEvent = {
        command,
        status: method === "item/started"
          ? "started"
          : item.status === "failed" || item.status === "declined" ? "failed" : "completed",
        ...(output ? { output } : {}),
      };
    }
    return normalized;
  }

  if (itemType === "agentMessage" && method === "item/completed") {
    normalized.assistantText = typeof item.text === "string" ? item.text : extractCodexText(item) ?? undefined;
    return normalized;
  }

  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabToolCall") {
    const id = typeof item.id === "string" ? item.id : null;
    const name = typeof item.tool === "string"
      ? itemType === "collabToolCall" ? normalizeCollabToolName(item.tool) : item.tool
      : null;
    if (id && name) {
      const output = itemType === "collabToolCall"
        ? extractCollabToolOutput(item)
        : itemType === "dynamicToolCall"
          ? extractCodexText(item.contentItems) ?? extractCodexText(item.success) ?? undefined
          : extractToolResultOutput(item.result) ?? extractCodexText(item.error) ?? undefined;
      normalized.toolEvent = {
        id,
        name,
        arguments: itemType === "collabToolCall"
          ? extractCollabToolArguments(item)
          : isCodexEventRecord(item.arguments) ? item.arguments : {},
        status: method === "item/started"
          ? "started"
          : item.status === "failed" || item.status === "declined" || isCodexEventRecord(item.error)
            ? "failed"
            : "completed",
        ...(output ? { output } : {}),
      };
    }
    return normalized;
  }

  if (itemType === "webSearch") {
    const id = typeof item.id === "string" ? item.id : null;
    if (!id) {
      return normalized;
    }

    const action = isCodexEventRecord(item.action) ? item.action : null;
    const actionType = typeof action?.type === "string" ? action.type : "search";
    if (actionType === "openPage" && typeof action?.url === "string") {
      normalized.toolEvent = {
        id,
        name: "open",
        arguments: { open: [{ ref_id: action.url }] },
        status: method === "item/started" ? "started" : "completed",
      };
      return normalized;
    }
    if (actionType === "findInPage" && typeof action?.url === "string" && typeof action?.pattern === "string") {
      normalized.toolEvent = {
        id,
        name: "find",
        arguments: { find: [{ ref_id: action.url, pattern: action.pattern }] },
        status: method === "item/started" ? "started" : "completed",
      };
      return normalized;
    }

    const query = typeof item.query === "string"
      ? item.query
      : Array.isArray(action?.queries) && typeof action.queries[0] === "string" ? action.queries[0] : null;
    if (query) {
      normalized.toolEvent = {
        id,
        name: "search_query",
        arguments: { search_query: [{ q: query }] },
        status: method === "item/started" ? "started" : "completed",
      };
    }
    return normalized;
  }

  if (itemType === "plan" && method === "item/completed") {
    normalized.planText = typeof item.text === "string" ? item.text : extractPlanText(item) ?? undefined;
    return normalized;
  }

  if (method === "item/completed" && itemType === "fileChange") {
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
