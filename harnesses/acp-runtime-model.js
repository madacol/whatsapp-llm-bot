import { inferFileChangeKindFromUnifiedDiff, isFileChangeKind } from "./file-change-utils.js";

/**
 * ACP runtime model.
 *
 * ACP session updates are incremental. This module owns the state needed to
 * turn partial protocol updates into stable harness runtime events without
 * leaking provider quirks into the runner.
 */

/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEvent} HarnessRuntimeEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeTool} HarnessRuntimeTool
 */

/**
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   kind?: string,
 *   status?: string,
 *   rawInput?: unknown,
 *   rawOutput?: unknown,
 *   content?: unknown,
 * }} AcpToolCallState
 */

/**
 * @typedef {{
 *   id: string,
 *   text: string,
 *   raw: Record<string, unknown>,
 * }} AcpAssistantSegment
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} keys
 * @returns {string | undefined}
 */
function firstString(value, keys) {
  for (const key of keys) {
    const text = stringOrNull(value[key]);
    if (text) {
      return text;
    }
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {"completed" | "in_progress" | "pending" | "unknown"}
 */
function normalizePlanStatus(value) {
  if (value === "completed") return "completed";
  if (value === "in_progress" || value === "inProgress" || value === "in-progress") return "in_progress";
  if (value === "pending") return "pending";
  return "unknown";
}

/**
 * @param {unknown} value
 * @returns {"started" | "updated" | "completed" | "failed"}
 */
function normalizeToolStatus(value) {
  if (value === "completed") return "completed";
  if (value === "failed" || value === "error") return "failed";
  if (value === "pending" || value === "in_progress" || value === "inProgress") return "started";
  return "updated";
}

/**
 * @param {string} method
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function createAcpRawPayload(method, payload) {
  return {
    source: "acp.jsonrpc",
    method,
    payload,
  };
}

/**
 * @param {Record<string, unknown>} update
 * @returns {LlmResponseMetadata | null}
 */
function extractMadabotSubagentMetadata(update) {
  const meta = isRecord(update._meta) ? update._meta : null;
  const madabot = isRecord(meta?.madabot) ? meta.madabot : null;
  const subagent = isRecord(madabot?.subagent) ? madabot.subagent : null;
  if (!subagent) return null;
  const threadId = stringOrNull(subagent.threadId);
  const parentThreadId = stringOrNull(subagent.parentThreadId);
  const agentNickname = stringOrNull(subagent.agentNickname);
  const agentRole = stringOrNull(subagent.agentRole);
  return {
    source: "subagent",
    ...(threadId ? { threadId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(agentNickname ? { agentNickname } : {}),
    ...(agentRole ? { agentRole } : {}),
  };
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string | null}
 */
function extractTextContent(update) {
  const content = isRecord(update.content) ? update.content : null;
  if (content?.type === "text") {
    return stringOrNull(content.text);
  }
  return null;
}

/**
 * @param {unknown} rawInput
 * @returns {Record<string, unknown>}
 */
function normalizeToolArguments(rawInput) {
  return isRecord(rawInput) ? { ...rawInput } : {};
}

/**
 * @param {AcpToolCallState} toolCall
 * @returns {string}
 */
function normalizeToolName(toolCall) {
  const title = stringOrNull(toolCall.title);
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
  const kind = stringOrNull(toolCall.kind);
  const subagentType = stringOrNull(rawInput?.subagent_type);
  if (subagentType || kind === "think") {
    return "Task";
  }
  return title ?? toolCall.id ?? "tool";
}

/**
 * @param {unknown} content
 * @returns {string | undefined}
 */
function summarizeToolContent(content) {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => {
      if (!isRecord(block)) return null;
      if (block.type === "content" && isRecord(block.content) && block.content.type === "text") {
        return stringOrNull(block.content.text);
      }
      if (block.type === "text") {
        return stringOrNull(block.text);
      }
      if (block.type === "diff") {
        return stringOrNull(block.path) ?? "[diff]";
      }
      return null;
    })
    .filter((value) => typeof value === "string" && value.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} keys
 * @returns {number | undefined}
 */
function firstNumber(value, keys) {
  for (const key of keys) {
    const number = numberOrUndefined(value[key]);
    if (number !== undefined) {
      return number;
    }
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} usage
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeUsage}
 */
export function normalizeAcpUsage(usage) {
  const cachedRead = firstNumber(usage, ["cached_read_tokens", "cachedReadTokens", "cachedRead"]) ?? 0;
  const cachedWrite = firstNumber(usage, ["cached_write_tokens", "cachedWriteTokens", "cachedWrite"]) ?? 0;
  const cost = isRecord(usage.cost) ? numberOrUndefined(usage.cost.amount) : numberOrUndefined(usage.cost);
  const contextWindow = firstNumber(usage, [
    "size",
    "contextWindow",
    "context_window",
    "context_window_tokens",
    "contextWindowTokens",
  ]);
  return {
    promptTokens: firstNumber(usage, ["input_tokens", "inputTokens", "promptTokens"]) ?? 0,
    completionTokens: firstNumber(usage, ["output_tokens", "outputTokens", "completionTokens"]) ?? 0,
    cachedTokens: firstNumber(usage, ["cached_tokens", "cachedTokens", "cachedInputTokens"]) ?? cachedRead + cachedWrite,
    cost: cost ?? 0,
    ...(firstNumber(usage, ["total_tokens", "totalTokens", "used"]) !== undefined ? { totalTokens: firstNumber(usage, ["total_tokens", "totalTokens", "used"]) } : {}),
    ...(firstNumber(usage, ["thought_tokens", "thoughtTokens", "reasoningTokens", "reasoningOutputTokens"]) !== undefined ? { reasoningTokens: firstNumber(usage, ["thought_tokens", "thoughtTokens", "reasoningTokens", "reasoningOutputTokens"]) } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * @param {Record<string, unknown>} block
 * @param {AcpToolCallState} toolCall
 * @param {Record<string, unknown>} raw
 * @returns {HarnessRuntimeEvent}
 */
function makeFileChangeEvent(block, toolCall, raw) {
  const oldText = typeof block.oldText === "string" ? block.oldText : undefined;
  const newText = typeof block.newText === "string" ? block.newText : undefined;
  const diff = typeof block.diff === "string"
    ? block.diff
    : typeof block.diffText === "string" ? block.diffText : undefined;
  const diffKind = inferFileChangeKindFromUnifiedDiff(diff);
  /** @type {"add" | "delete" | "update"} */
  const kind = isFileChangeKind(block.kind)
    ? block.kind
    : oldText === undefined && newText === undefined
      ? diffKind ?? "update"
      : oldText === undefined
        ? "add"
        : newText === undefined ? "delete" : "update";
  return {
    type: "file-change.completed",
    provider: "acp",
    change: {
      path: /** @type {string} */ (block.path),
      kind,
      ...(typeof toolCall.title === "string" ? { summary: toolCall.title } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    },
    raw,
  };
}

/**
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function extractDiffBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isRecord)
    .filter((block) => block.type === "diff" && typeof block.path === "string");
}

/**
 * @param {AcpToolCallState | undefined} previous
 * @param {AcpToolCallState} next
 * @returns {AcpToolCallState}
 */
export function mergeAcpToolCallState(previous, next) {
  return {
    id: next.id || previous?.id || `acp-tool:${Date.now()}`,
    title: next.title ?? previous?.title,
    kind: next.kind ?? previous?.kind,
    status: next.status ?? previous?.status,
    rawInput: next.rawInput ?? previous?.rawInput,
    rawOutput: next.rawOutput ?? previous?.rawOutput,
    content: next.content ?? previous?.content,
  };
}

/**
 * @param {Record<string, unknown>} update
 * @returns {AcpToolCallState}
 */
function readToolCallState(update) {
  return {
    id: stringOrNull(update.toolCallId) ?? `acp-tool:${Date.now()}`,
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(typeof update.status === "string" ? { status: update.status } : {}),
    ...("rawInput" in update ? { rawInput: update.rawInput } : {}),
    ...("rawOutput" in update ? { rawOutput: update.rawOutput } : {}),
    ...("content" in update ? { content: update.content } : {}),
  };
}

/**
 * @param {AcpToolCallState} toolCall
 * @returns {HarnessRuntimeTool}
 */
function makeRuntimeTool(toolCall) {
  const rawInput = normalizeToolArguments(toolCall.rawInput);
  const name = normalizeToolName(toolCall);
  const includeTitleArgument = name === "Task" && typeof toolCall.title === "string" && toolCall.title.length > 0;
  return {
    id: toolCall.id,
    name,
    arguments: {
      ...(includeTitleArgument ? { title: toolCall.title } : {}),
      ...rawInput,
    },
    ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
  };
}

/**
 * @param {AcpToolCallState} toolCall
 * @param {Record<string, unknown>} raw
 * @returns {HarnessRuntimeEvent[]}
 */
function makeToolEvents(toolCall, raw) {
  const status = normalizeToolStatus(toolCall.status);
  const events = /** @type {HarnessRuntimeEvent[]} */ ([{
    type: status === "failed" ? "tool.failed" : status === "completed" ? "tool.completed" : status === "started" ? "tool.started" : "tool.updated",
    provider: "acp",
    tool: makeRuntimeTool(toolCall),
    raw,
  }]);
  if (status === "completed") {
    for (const diffBlock of extractDiffBlocks(toolCall.content)) {
      events.push(makeFileChangeEvent(diffBlock, toolCall, raw));
    }
  }
  return events;
}

/**
 * @returns {{
 *   acceptSessionUpdate: (raw: Record<string, unknown>) => HarnessRuntimeEvent[],
 *   flushAssistantSegment: () => HarnessRuntimeEvent[],
 * }}
 */
export function createAcpRuntimeModel() {
  /** @type {Map<string, AcpToolCallState>} */
  const toolCalls = new Map();
  /** @type {AcpAssistantSegment | null} */
  let assistantSegment = null;
  let nextAssistantId = 1;

  /**
   * @returns {HarnessRuntimeEvent[]}
   */
  function flushAssistantSegment() {
    if (!assistantSegment) return [];
    const completed = assistantSegment;
    assistantSegment = null;
    return [{
      type: "item.completed",
      provider: "acp",
      item: {
        id: completed.id,
        kind: "assistant",
        text: completed.text,
      },
      raw: completed.raw,
    }];
  }

  /**
   * @param {Record<string, unknown>} raw
   * @returns {HarnessRuntimeEvent[]}
   */
  function acceptSessionUpdate(raw) {
    const update = isRecord(raw.update) ? raw.update : null;
    if (!update || typeof update.sessionUpdate !== "string") return [];
    const eventRaw = createAcpRawPayload("session/update", raw);

    if (update.sessionUpdate === "agent_message_chunk") {
      const text = extractTextContent(update);
      if (!text) return [];
      const subagentMetadata = extractMadabotSubagentMetadata(update);
      if (subagentMetadata) {
        return [
          ...flushAssistantSegment(),
          {
            type: "subagent.completed",
            provider: "acp",
            text,
            metadata: subagentMetadata,
            raw: eventRaw,
          },
        ];
      }
      /** @type {HarnessRuntimeEvent[]} */
      const events = [];
      if (!assistantSegment) {
        assistantSegment = {
          id: `acp-assistant-${nextAssistantId}`,
          text: "",
          raw: eventRaw,
        };
        nextAssistantId += 1;
        events.push({
          type: "item.started",
          provider: "acp",
          item: { id: assistantSegment.id, kind: "assistant" },
          raw: eventRaw,
        });
      }
      assistantSegment.text += text;
      events.push({
        type: "content.delta",
        provider: "acp",
        itemId: assistantSegment.id,
        text,
        displayText: text,
        contentType: "markdown",
        raw: eventRaw,
      });
      return events;
    }

    const prefix = flushAssistantSegment();

    if (update.sessionUpdate === "agent_thought_chunk") {
      const text = extractTextContent(update);
      return text
        ? [...prefix, {
            type: "reasoning.updated",
            provider: "acp",
            status: "updated",
            text,
            contentParts: [text],
            summaryParts: [],
            raw: eventRaw,
          }]
        : prefix;
    }

    if (update.sessionUpdate === "plan") {
      const entries = Array.isArray(update.entries)
        ? update.entries
          .filter(isRecord)
          .map((entry) => ({
            text: stringOrNull(entry.content) ?? stringOrNull(entry.text) ?? "",
            status: normalizePlanStatus(entry.status),
          }))
          .filter((entry) => entry.text.length > 0)
        : [];
      return [...prefix, {
        type: "plan.updated",
        provider: "acp",
        plan: {
          explanation: stringOrNull(update.explanation),
          entries,
        },
        raw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "usage_update") {
      return [...prefix, {
        type: "usage.updated",
        provider: "acp",
        usage: normalizeAcpUsage(update),
        raw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "model_rerouted" || update.sessionUpdate === "model-rerouted") {
      return [...prefix, {
        type: "model.rerouted",
        provider: "acp",
        ...(firstString(update, ["fromModel", "from_model", "from"]) ? { fromModel: firstString(update, ["fromModel", "from_model", "from"]) } : {}),
        ...(firstString(update, ["toModel", "to_model", "to"]) ? { toModel: firstString(update, ["toModel", "to_model", "to"]) } : {}),
        ...(firstString(update, ["reason", "message"]) ? { reason: firstString(update, ["reason", "message"]) } : {}),
        raw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "config_warning" || update.sessionUpdate === "config-warning") {
      return [...prefix, {
        type: "config.warning",
        provider: "acp",
        ...(firstString(update, ["summary", "message"]) ? { summary: firstString(update, ["summary", "message"]) } : {}),
        ...(firstString(update, ["details", "detail"]) ? { details: firstString(update, ["details", "detail"]) } : {}),
        ...(firstString(update, ["path"]) ? { path: firstString(update, ["path"]) } : {}),
        raw: eventRaw,
      }];
    }

    if (
      update.sessionUpdate === "runtime_error" ||
      update.sessionUpdate === "runtime-error" ||
      update.sessionUpdate === "runtime_warning" ||
      update.sessionUpdate === "runtime-warning"
    ) {
      const isError = update.sessionUpdate === "runtime_error" || update.sessionUpdate === "runtime-error";
      return [...prefix, {
        type: isError ? "runtime.error" : "runtime.warning",
        provider: "acp",
        ...(firstString(update, ["message", "summary"]) ? { message: firstString(update, ["message", "summary"]) } : {}),
        ...(firstString(update, ["details", "detail"]) ? { details: firstString(update, ["details", "detail"]) } : {}),
        ...(isError ? { class: "provider_error" } : {}),
        raw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const next = readToolCallState(update);
      const merged = mergeAcpToolCallState(toolCalls.get(next.id), next);
      const status = normalizeToolStatus(merged.status);
      if (status === "completed" || status === "failed") {
        toolCalls.delete(merged.id);
      } else {
        toolCalls.set(merged.id, merged);
      }
      return [...prefix, ...makeToolEvents(merged, eventRaw)];
    }

    return prefix;
  }

  return {
    acceptSessionUpdate,
    flushAssistantSegment,
  };
}

/**
 * Stateless compatibility helper for tests and one-off normalization.
 * @param {Record<string, unknown>} raw
 * @returns {HarnessRuntimeEvent[]}
 */
export function normalizeAcpSessionUpdate(raw) {
  return createAcpRuntimeModel().acceptSessionUpdate(raw);
}
