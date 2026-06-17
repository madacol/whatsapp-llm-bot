import { inferFileChangeKindFromUnifiedDiff, isFileChangeKind } from "./file-change-utils.js";
import { extractApplyPatchText } from "./apply-patch-parser.js";

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
 *   locations?: unknown,
 *   meta?: unknown,
 *   content?: unknown,
 * }} AcpToolCallState
 */

/**
 * @typedef {{
 *   id: string,
 *   text: string,
 *   diagnosticRaw: Record<string, unknown>,
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
 * @param {unknown} value
 * @returns {string | null}
 */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
 * @param {unknown} value
 * @returns {{ start: number, end: number } | null}
 */
function normalizeLineRange(value) {
  if (!isRecord(value)) {
    return null;
  }
  const { start, end } = value;
  if (typeof start !== "number"
    || typeof end !== "number"
    || !Number.isInteger(start)
    || !Number.isInteger(end)
    || start <= 0
    || end < start) {
    return null;
  }
  return { start, end };
}

/**
 * @param {unknown} locations
 * @returns {Record<string, unknown> | null}
 */
function getFirstLocation(locations) {
  const entries = Array.isArray(locations) ? locations : [];
  for (const location of entries) {
    if (isRecord(location) && nonEmptyString(location.path)) {
      return location;
    }
  }
  return null;
}

/**
 * @param {AcpToolCallState} toolCall
 * @returns {{ start: number, end: number } | null}
 */
function getCodexLineRange(toolCall) {
  const meta = isRecord(toolCall.meta) ? toolCall.meta : null;
  const codex = isRecord(meta?.codex) ? meta.codex : null;
  return normalizeLineRange(codex?.lineRange);
}

/**
 * @param {string} output
 * @returns {{ start: number, end: number } | null}
 */
function parseNumberedLineRange(output) {
  /** @type {number | null} */
  let start = null;
  /** @type {number | null} */
  let end = null;
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)(?:\t|→)/u);
    if (!match) {
      continue;
    }
    const lineNumber = Number(match[1]);
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) {
      continue;
    }
    start ??= lineNumber;
    end = lineNumber;
  }
  return start !== null && end !== null ? { start, end } : null;
}

/**
 * @param {AcpToolCallState} toolCall
 * @returns {{ start: number, end: number } | null}
 */
function getOutputLineRange(toolCall) {
  const rawOutput = isRecord(toolCall.rawOutput) ? toolCall.rawOutput : null;
  return typeof rawOutput?.formatted_output === "string"
    ? parseNumberedLineRange(rawOutput.formatted_output)
    : null;
}

/**
 * @param {AcpToolCallState} toolCall
 * @returns {boolean}
 */
function hasTerminalOutputDelta(toolCall) {
  const meta = isRecord(toolCall.meta) ? toolCall.meta : null;
  return isRecord(meta?.terminal_output_delta);
}

/**
 * @param {string | null} title
 * @returns {boolean}
 */
function isListFilesTitle(title) {
  return title === "List files" || !!title?.startsWith("List files in ");
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function joinedStringList(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries = value.map(nonEmptyString).filter((entry) => entry !== null);
  return entries.length > 0 ? entries.join(", ") : null;
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
  if (kind === "search" && typeof rawInput?.pattern === "string" && typeof rawInput.path === "string") {
    return "Search";
  }
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
 * @param {Record<string, unknown>} diagnosticRaw
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput}
 */
function makeFileChangeEvent(block, toolCall, diagnosticRaw) {
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
      source: "tool",
      ...(typeof toolCall.title === "string" ? { summary: toolCall.title } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    },
    diagnosticRaw,
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
 * @param {string} filePath
 * @param {"add" | "update"} kind
 * @param {string[]} bodyLines
 * @returns {string}
 */
function buildPatchDiffText(filePath, kind, bodyLines) {
  const header = kind === "add"
    ? ["--- /dev/null", `+++ b/${filePath}`]
    : [`--- a/${filePath}`, `+++ b/${filePath}`];
  const hasHunkHeader = bodyLines.some((line) => line.startsWith("@@"));
  const hunk = hasHunkHeader
    ? bodyLines
    : [`@@ -0,0 +1,${bodyLines.length} @@`, ...bodyLines];
  return [...header, ...hunk].join("\n");
}

/**
 * @param {unknown} rawInput
 * @returns {Record<string, unknown>[]}
 */
function extractApplyPatchDiffBlocks(rawInput) {
  const patchText = extractApplyPatchText(rawInput);
  if (!patchText) {
    return [];
  }
  /** @type {Array<{ path: string, kind: "add" | "update", lines: string[] }>} */
  const parsed = [];
  /** @type {{ path: string, kind: "add" | "update", lines: string[] } | null} */
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    const hasChangedLine = current.lines.some((line) => line.startsWith("+") || line.startsWith("-"));
    if (hasChangedLine) {
      parsed.push(current);
    }
    current = null;
  };

  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("*** Update File: ")) {
      finishCurrent();
      current = { path: line.slice("*** Update File: ".length).trim(), kind: "update", lines: [] };
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      finishCurrent();
      current = { path: line.slice("*** Add File: ".length).trim(), kind: "add", lines: [] };
      continue;
    }
    if (line.startsWith("*** ")) {
      finishCurrent();
      continue;
    }
    if (!current) {
      continue;
    }
    if (current.kind === "add") {
      if (line.startsWith("+")) {
        current.lines.push(line);
      }
      continue;
    }
    if (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      current.lines.push(line);
    }
  }
  finishCurrent();

  return parsed.map((entry) => ({
    type: "diff",
    path: entry.path,
    kind: entry.kind,
    diff: buildPatchDiffText(entry.path, entry.kind, entry.lines),
  }));
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
    locations: next.locations ?? previous?.locations,
    meta: next.meta ?? previous?.meta,
    content: next.content ?? previous?.content,
  };
}

/**
 * @param {Record<string, unknown>} update
 * @returns {AcpToolCallState}
 */
function readToolCallState(update) {
  const status = typeof update.status === "string"
    ? update.status
    : update.sessionUpdate === "tool_call"
      ? "in_progress"
      : undefined;
  return {
    id: stringOrNull(update.toolCallId) ?? `acp-tool:${Date.now()}`,
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(status ? { status } : {}),
    ...("rawInput" in update ? { rawInput: update.rawInput } : {}),
    ...("rawOutput" in update ? { rawOutput: update.rawOutput } : {}),
    ...("locations" in update ? { locations: update.locations } : {}),
    ...("_meta" in update ? { meta: update._meta } : {}),
    ...("content" in update ? { content: update.content } : {}),
  };
}

/**
 * @param {AcpToolCallState} toolCall
 * @returns {HarnessRuntimeTool}
 */
function makeRuntimeTool(toolCall) {
  const rawInput = normalizeToolArguments(toolCall.rawInput);
  const rawInputRecord = isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
  const kind = stringOrNull(toolCall.kind);
  const name = normalizeToolName(toolCall);
  const includeTitleArgument = name === "Task" && typeof toolCall.title === "string" && toolCall.title.length > 0;
  const suppressProgress = hasTerminalOutputDelta(toolCall);
  if (kind === "read") {
    const title = nonEmptyString(toolCall.title);
    if (isListFilesTitle(title)) {
      const listPath = nonEmptyString(getFirstLocation(toolCall.locations)?.path);
      return {
        id: toolCall.id,
        name: "List",
        arguments: {
          ...(listPath ? { path: listPath } : {}),
        },
        ...(suppressProgress ? { suppressProgress } : {}),
        ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
      };
    }
    const location = getFirstLocation(toolCall.locations);
    const readPath = nonEmptyString(location?.path) ?? nonEmptyString(rawInputRecord?.path);
    if (readPath) {
      const codexRange = getCodexLineRange(toolCall);
      const outputRange = getOutputLineRange(toolCall);
      const rawLine = numberOrUndefined(rawInputRecord?.line) ?? numberOrUndefined(rawInputRecord?.offset);
      const line = codexRange?.start ?? numberOrUndefined(location?.line) ?? rawLine ?? outputRange?.start;
      const limit = codexRange
        ? codexRange.end - codexRange.start + 1
        : numberOrUndefined(rawInputRecord?.limit) ?? (outputRange ? outputRange.end - outputRange.start + 1 : undefined);
      return {
        id: toolCall.id,
        name: "Read",
        arguments: {
          file_path: readPath,
          ...(line !== undefined ? { line } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        ...(suppressProgress ? { suppressProgress } : {}),
        ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
      };
    }
  }
  if (kind === "execute") {
    const command = nonEmptyString(rawInputRecord?.command)
      ?? (nonEmptyString(toolCall.title) !== "Editing files" ? nonEmptyString(toolCall.title) : null);
    if (command) {
      return {
        id: toolCall.id,
        name: "Shell",
        arguments: {
          command,
        },
        ...(suppressProgress ? { suppressProgress } : {}),
        ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
      };
    }
  }
  const action = isRecord(rawInputRecord?.action) ? rawInputRecord.action : null;
  const actionType = nonEmptyString(action?.type);
  if (kind === "search" && action && actionType) {
    if (actionType === "other") {
      return {
        id: toolCall.id,
        name: "web_action_pending",
        arguments: {},
        ...(suppressProgress ? { suppressProgress } : {}),
        ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
      };
    }
    if (actionType === "search") {
      const query = nonEmptyString(action.query)
        ?? joinedStringList(action.queries)
        ?? nonEmptyString(rawInputRecord?.query);
      if (query) {
        return {
          id: toolCall.id,
          name: "web_search_action",
          arguments: { query },
          ...(suppressProgress ? { suppressProgress } : {}),
          ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
        };
      }
    }
    if (actionType === "openPage" || actionType === "open_page") {
      const refId = nonEmptyString(action.url);
      if (refId) {
        return {
          id: toolCall.id,
          name: "open",
          arguments: { ref_id: refId },
          ...(suppressProgress ? { suppressProgress } : {}),
          ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
        };
      }
    }
    if (actionType === "findInPage" || actionType === "find_in_page") {
      const pattern = nonEmptyString(action.pattern);
      const refId = nonEmptyString(action.url);
      if (pattern && refId) {
        return {
          id: toolCall.id,
          name: "find",
          arguments: { pattern, ref_id: refId },
          ...(suppressProgress ? { suppressProgress } : {}),
          ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
        };
      }
    }
  }
  return {
    id: toolCall.id,
    name,
    arguments: {
      ...(includeTitleArgument ? { title: toolCall.title } : {}),
      ...rawInput,
    },
    ...(suppressProgress ? { suppressProgress } : {}),
    ...(summarizeToolContent(toolCall.content) ? { output: summarizeToolContent(toolCall.content) } : {}),
  };
}

/**
 * @param {AcpToolCallState} toolCall
 * @param {Record<string, unknown>} diagnosticRaw
 * @param {{ wasActive?: boolean }} [options]
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]}
 */
function makeToolEvents(toolCall, diagnosticRaw, options = {}) {
  const status = normalizeToolStatus(toolCall.status);
  const type = status === "failed"
    ? "tool.failed"
    : status === "completed"
      ? "tool.completed"
      : status === "started" && !options.wasActive
        ? "tool.started"
        : "tool.updated";
  const events = /** @type {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]} */ ([{
    type,
    provider: "acp",
    tool: makeRuntimeTool(toolCall),
    diagnosticRaw,
  }]);
  if (status === "completed") {
    const contentDiffBlocks = extractDiffBlocks(toolCall.content);
    const diffBlocks = contentDiffBlocks.length > 0
      ? contentDiffBlocks
      : extractApplyPatchDiffBlocks(toolCall.rawInput);
    for (const diffBlock of diffBlocks) {
      events.push(makeFileChangeEvent(diffBlock, toolCall, diagnosticRaw));
    }
  }
  return events;
}

/**
 * @returns {{
 *   acceptSessionUpdate: (raw: Record<string, unknown>) => import("./harness-runtime-events.js").HarnessRuntimeEventInput[],
 *   flushAssistantSegment: () => import("./harness-runtime-events.js").HarnessRuntimeEventInput[],
 * }}
 */
export function createAcpRuntimeModel() {
  /** @type {Map<string, AcpToolCallState>} */
  const toolCalls = new Map();
  /** @type {AcpAssistantSegment | null} */
  let assistantSegment = null;
  let nextAssistantId = 1;

  /**
   * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]}
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
      diagnosticRaw: completed.diagnosticRaw,
    }];
  }

  /**
   * @param {string} text
   * @returns {boolean}
   */
  function isGuardianReviewText(text) {
    return /^Guardian warning: Automatic approval review (approved|denied)\b/.test(text.trim());
  }

  /**
   * @param {Record<string, unknown>} update
   * @returns {boolean}
   */
  function shouldFlushAssistantBeforeUpdate(update) {
    if (!assistantSegment) {
      return false;
    }
    if (update.sessionUpdate !== "tool_call_update") {
      return true;
    }
    return isGuardianReviewText(assistantSegment.text);
  }

  /**
   * @param {Record<string, unknown>} raw
   * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]}
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
            diagnosticRaw: eventRaw,
          },
        ];
      }
      /** @type {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]} */
      const events = [];
      if (!assistantSegment) {
        assistantSegment = {
          id: `acp-assistant-${nextAssistantId}`,
          text: "",
          diagnosticRaw: eventRaw,
        };
        nextAssistantId += 1;
        events.push({
          type: "item.started",
          provider: "acp",
          item: { id: assistantSegment.id, kind: "assistant" },
          diagnosticRaw: eventRaw,
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
        diagnosticRaw: eventRaw,
      });
      return events;
    }

    const prefix = shouldFlushAssistantBeforeUpdate(update) ? flushAssistantSegment() : [];

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
            appendMode: "delta",
            diagnosticRaw: eventRaw,
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
        diagnosticRaw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "usage_update") {
      return [...prefix, {
        type: "usage.updated",
        provider: "acp",
        usage: normalizeAcpUsage(update),
        diagnosticRaw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "model_rerouted" || update.sessionUpdate === "model-rerouted") {
      return [...prefix, {
        type: "model.rerouted",
        provider: "acp",
        ...(firstString(update, ["fromModel", "from_model", "from"]) ? { fromModel: firstString(update, ["fromModel", "from_model", "from"]) } : {}),
        ...(firstString(update, ["toModel", "to_model", "to"]) ? { toModel: firstString(update, ["toModel", "to_model", "to"]) } : {}),
        ...(firstString(update, ["reason", "message"]) ? { reason: firstString(update, ["reason", "message"]) } : {}),
        diagnosticRaw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "config_warning" || update.sessionUpdate === "config-warning") {
      return [...prefix, {
        type: "config.warning",
        provider: "acp",
        ...(firstString(update, ["summary", "message"]) ? { summary: firstString(update, ["summary", "message"]) } : {}),
        ...(firstString(update, ["details", "detail"]) ? { details: firstString(update, ["details", "detail"]) } : {}),
        ...(firstString(update, ["path"]) ? { path: firstString(update, ["path"]) } : {}),
        diagnosticRaw: eventRaw,
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
        diagnosticRaw: eventRaw,
      }];
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const next = readToolCallState(update);
      const previous = toolCalls.get(next.id);
      const merged = mergeAcpToolCallState(previous, next);
      const status = normalizeToolStatus(merged.status);
      if (status === "completed" || status === "failed") {
        toolCalls.delete(merged.id);
      } else {
        toolCalls.set(merged.id, merged);
      }
      return [...prefix, ...makeToolEvents(merged, eventRaw, { wasActive: previous !== undefined })];
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
   * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]}
 */
export function normalizeAcpSessionUpdate(raw) {
  return createAcpRuntimeModel().acceptSessionUpdate(raw);
}
