/**
 * ACP session/update normalization.
 *
 * The ACP core schema is intentionally generic. This module keeps provider
 * quirks at the protocol edge and emits the bot's canonical runtime events.
 */

/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEvent} HarnessRuntimeEvent
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
 * @returns {"completed" | "in_progress" | "pending" | "unknown"}
 */
function normalizePlanStatus(value) {
  if (value === "completed") {
    return "completed";
  }
  if (value === "in_progress" || value === "inProgress" || value === "in-progress") {
    return "in_progress";
  }
  if (value === "pending") {
    return "pending";
  }
  return "unknown";
}

/**
 * @param {unknown} value
 * @returns {"started" | "updated" | "completed" | "failed"}
 */
function normalizeToolStatus(value) {
  if (value === "completed") {
    return "completed";
  }
  if (value === "failed" || value === "error") {
    return "failed";
  }
  if (value === "pending" || value === "in_progress" || value === "inProgress") {
    return "started";
  }
  return "updated";
}

/**
 * @param {Record<string, unknown>} update
 * @returns {LlmResponseMetadata | null}
 */
function extractMadabotSubagentMetadata(update) {
  const meta = isRecord(update._meta) ? update._meta : null;
  const madabot = isRecord(meta?.madabot) ? meta.madabot : null;
  const subagent = isRecord(madabot?.subagent) ? madabot.subagent : null;
  if (!subagent) {
    return null;
  }
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
 * @param {Record<string, unknown>} update
 * @returns {string}
 */
function normalizeToolName(update) {
  const title = stringOrNull(update.title);
  const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
  const kind = stringOrNull(update.kind);
  const subagentType = stringOrNull(rawInput?.subagent_type);
  if (subagentType || kind === "think") {
    return "Task";
  }
  return title ?? stringOrNull(update.toolCallId) ?? "tool";
}

/**
 * @param {unknown} content
 * @returns {string | undefined}
 */
function summarizeToolContent(content) {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .map((block) => {
      if (!isRecord(block)) {
        return null;
      }
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
 * @param {Record<string, unknown>} update
 * @returns {Array<Parameters<typeof makeFileChangeEvent>[0]>}
 */
function extractDiffBlocks(update) {
  if (!Array.isArray(update.content)) {
    return [];
  }
  return update.content
    .filter(isRecord)
    .filter((block) => block.type === "diff" && typeof block.path === "string");
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {Record<string, unknown>} usage
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeUsage}
 */
export function normalizeAcpUsage(usage) {
  const cachedRead = numberOrUndefined(usage.cached_read_tokens) ?? 0;
  const cachedWrite = numberOrUndefined(usage.cached_write_tokens) ?? 0;
  const cost = isRecord(usage.cost) ? numberOrUndefined(usage.cost.amount) : numberOrUndefined(usage.cost);
  return {
    promptTokens: numberOrUndefined(usage.input_tokens) ?? numberOrUndefined(usage.promptTokens) ?? 0,
    completionTokens: numberOrUndefined(usage.output_tokens) ?? numberOrUndefined(usage.completionTokens) ?? 0,
    cachedTokens: numberOrUndefined(usage.cachedTokens) ?? cachedRead + cachedWrite,
    cost: cost ?? 0,
    ...(numberOrUndefined(usage.total_tokens) !== undefined ? { totalTokens: numberOrUndefined(usage.total_tokens) } : {}),
    ...(numberOrUndefined(usage.thought_tokens) !== undefined ? { reasoningTokens: numberOrUndefined(usage.thought_tokens) } : {}),
    ...(numberOrUndefined(usage.size) !== undefined ? { contextWindow: numberOrUndefined(usage.size) } : {}),
  };
}

/**
 * @param {Record<string, unknown>} block
 * @param {Record<string, unknown>} update
 * @param {Record<string, unknown>} raw
 * @returns {HarnessRuntimeEvent}
 */
function makeFileChangeEvent(block, update, raw) {
  const oldText = typeof block.oldText === "string" ? block.oldText : undefined;
  const newText = typeof block.newText === "string" ? block.newText : undefined;
  /** @type {"add" | "delete" | "update"} */
  const kind = oldText === undefined || oldText === null
    ? "add"
    : newText === undefined || newText === null ? "delete" : "update";
  return {
    type: "file-change.completed",
    provider: "acp",
    change: {
      path: /** @type {string} */ (block.path),
      kind,
      ...(typeof update.title === "string" ? { summary: update.title } : {}),
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    },
    raw,
  };
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {HarnessRuntimeEvent[]}
 */
export function normalizeAcpSessionUpdate(raw) {
  const update = isRecord(raw.update) ? raw.update : null;
  if (!update || typeof update.sessionUpdate !== "string") {
    return [];
  }

  if (update.sessionUpdate === "agent_message_chunk") {
    const text = extractTextContent(update);
    if (!text) {
      return [];
    }
    const subagentMetadata = extractMadabotSubagentMetadata(update);
    if (subagentMetadata) {
      return [{
        type: "subagent.completed",
        provider: "acp",
        text,
        metadata: subagentMetadata,
        raw,
      }];
    }
    return [{
      type: "assistant.completed",
      provider: "acp",
      text,
      displayText: text,
      contentType: "markdown",
      responseMode: "append",
      raw,
    }];
  }

  if (update.sessionUpdate === "agent_thought_chunk") {
    const text = extractTextContent(update);
    return text
      ? [{
          type: "reasoning.updated",
          provider: "acp",
          status: "updated",
          text,
          contentParts: [text],
          summaryParts: [],
          raw,
        }]
      : [];
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
    return [{
      type: "plan.updated",
      provider: "acp",
      plan: {
        explanation: stringOrNull(update.explanation),
        entries,
      },
      raw,
    }];
  }

  if (update.sessionUpdate === "usage_update") {
    return [{
      type: "usage.updated",
      provider: "acp",
      usage: normalizeAcpUsage(update),
      raw,
    }];
  }

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const id = stringOrNull(update.toolCallId) ?? `acp-tool:${Date.now()}`;
    const rawInput = normalizeToolArguments(update.rawInput);
    const title = stringOrNull(update.title);
    const name = normalizeToolName(update);
    const includeTitleArgument = name === "Task" && title;
    const argumentsObject = {
      ...(includeTitleArgument ? { title } : {}),
      ...rawInput,
    };
    const status = normalizeToolStatus(update.status);
    const output = summarizeToolContent(update.content);
    /** @type {HarnessRuntimeEvent[]} */
    const events = [{
      type: status === "failed" ? "tool.failed" : status === "completed" ? "tool.completed" : status === "started" ? "tool.started" : "tool.updated",
      provider: "acp",
      tool: {
        id,
        name,
        arguments: argumentsObject,
        ...(output ? { output } : {}),
      },
      raw,
    }];
    if (status === "completed") {
      for (const diffBlock of extractDiffBlocks(update)) {
        events.push(makeFileChangeEvent(diffBlock, update, raw));
      }
    }
    return events;
  }

  return [];
}
