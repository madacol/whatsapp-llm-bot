/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeEvent} HarnessRuntimeEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeUsage} HarnessRuntimeUsage
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is Array<Record<string, unknown>>}
 */
function isRecordArray(value) {
  return Array.isArray(value) && value.every((entry) => isObjectRecord(entry));
}

/**
 * @param {Record<string, unknown>} response
 * @returns {Record<string, unknown>}
 */
function getResponseData(response) {
  return isObjectRecord(response.data) ? response.data : {};
}

/**
 * @param {Record<string, unknown>} message
 * @returns {string | null}
 */
function extractAssistantText(message) {
  if (!isObjectRecord(message) || !Array.isArray(message.content)) {
    return null;
  }
  const parts = message.content
    .filter((entry) => isObjectRecord(entry) && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text);
  const text = parts.join("").trim();
  return text || null;
}

/**
 * @param {Record<string, unknown>} message
 * @returns {HarnessRuntimeUsage}
 */
function extractAssistantUsage(message) {
  if (!isObjectRecord(message.usage)) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    };
  }
  const usage = message.usage;
  const cost = isObjectRecord(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
  return {
    promptTokens: typeof usage.input === "number" ? usage.input : 0,
    completionTokens: typeof usage.output === "number" ? usage.output : 0,
    cachedTokens: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
    cost,
  };
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string | null}
 */
function extractThinkingText(event) {
  if (!isObjectRecord(event.message) || !Array.isArray(event.message.content)) {
    return null;
  }
  const parts = event.message.content
    .filter((entry) => isObjectRecord(entry) && entry.type === "thinking" && typeof entry.thinking === "string")
    .map((entry) => entry.thinking);
  const text = parts.join("\n").trim();
  return text || null;
}

/**
 * @param {Record<string, unknown>} result
 * @returns {string | undefined}
 */
function extractToolResultText(result) {
  if (!isObjectRecord(result) || !Array.isArray(result.content)) {
    return undefined;
  }
  const text = result.content
    .filter((entry) => isObjectRecord(entry) && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {{ id: string, name: string, args: Record<string, unknown> } | null}
 */
function extractToolStart(event) {
  if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
    return null;
  }
  const args = isObjectRecord(event.args) ? event.args : {};
  return {
    id: event.toolCallId,
    name: event.toolName,
    args,
  };
}

/**
 * @param {Record<string, unknown>} event
 * @returns {Array<Record<string, unknown>>}
 */
function extractAgentEndMessages(event) {
  return isRecordArray(event.messages) ? event.messages : [];
}

/**
 * @param {Record<string, unknown>} event
 * @returns {HarnessRuntimeEvent[]}
 */
function normalizeAgentEnd(event) {
  const messages = extractAgentEndMessages(event);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(message);
    if (!text) {
      return [];
    }
    return [{
      type: "assistant.completed",
      provider: "pi",
      text,
      contentType: "markdown",
      usage: extractAssistantUsage(message),
      raw: event,
    }];
  }
  return [];
}

/**
 * Normalize one Pi RPC notification into canonical harness runtime events.
 * @param {Record<string, unknown>} event
 * @returns {HarnessRuntimeEvent[]}
 */
export function normalizePiRuntimeEvents(event) {
  if (event.type === "message_update" && isObjectRecord(event.assistantMessageEvent)) {
    const assistantMessageEvent = event.assistantMessageEvent;
    if (
      assistantMessageEvent.type === "thinking_start"
      || assistantMessageEvent.type === "thinking_delta"
      || assistantMessageEvent.type === "thinking_end"
    ) {
      const text = extractThinkingText(event);
      if (!text) {
        return [];
      }
      return [{
        type: assistantMessageEvent.type === "thinking_end"
          ? "reasoning.completed"
          : assistantMessageEvent.type === "thinking_start" ? "reasoning.started" : "reasoning.updated",
        provider: "pi",
        status: assistantMessageEvent.type === "thinking_end"
          ? "completed"
          : assistantMessageEvent.type === "thinking_start" ? "started" : "updated",
        text,
        raw: event,
      }];
    }
  }

  if (event.type === "tool_execution_start") {
    const toolStart = extractToolStart(event);
    if (!toolStart) {
      return [];
    }
    return [{
      type: "tool.started",
      provider: "pi",
      tool: {
        id: toolStart.id,
        name: toolStart.name,
        arguments: toolStart.args,
      },
      raw: event,
    }];
  }

  if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
    return [{
      type: "tool.updated",
      provider: "pi",
      tool: {
        id: event.toolCallId,
        name: typeof event.toolName === "string" ? event.toolName : "tool",
        arguments: isObjectRecord(event.args) ? event.args : {},
        output: isObjectRecord(event.partialResult) ? extractToolResultText(event.partialResult) : undefined,
      },
      raw: event,
    }];
  }

  if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
    return [{
      type: "tool.completed",
      provider: "pi",
      tool: {
        id: event.toolCallId,
        name: typeof event.toolName === "string" ? event.toolName : "tool",
        arguments: isObjectRecord(event.args) ? event.args : {},
        output: isObjectRecord(event.result) ? extractToolResultText(event.result) : undefined,
      },
      raw: event,
    }];
  }

  if (event.type === "agent_end") {
    return normalizeAgentEnd(event);
  }

  return [];
}

export { extractAssistantText, extractAssistantUsage, extractToolResultText, getResponseData };
