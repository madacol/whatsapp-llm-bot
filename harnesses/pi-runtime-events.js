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
 * Pi RPC emits built-in names in lowercase with Pi-native argument names.
 * Normalize those to the display-oriented names used by the app hooks.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {{ name: string, args: Record<string, unknown> }}
 */
function normalizePiToolForDisplay(name, args) {
  switch (name) {
    case "read":
      return {
        name: "Read",
        args: {
          ...args,
          ...(typeof args.path === "string" ? { file_path: args.path } : {}),
        },
      };
    case "bash":
      return { name: "Bash", args };
    case "edit": {
      const firstEdit = Array.isArray(args.edits) && isObjectRecord(args.edits[0]) ? args.edits[0] : {};
      return {
        name: "Edit",
        args: {
          ...args,
          ...(typeof args.path === "string" ? { file_path: args.path } : {}),
          ...(typeof firstEdit.oldText === "string" ? { old_string: firstEdit.oldText } : {}),
          ...(typeof firstEdit.newText === "string" ? { new_string: firstEdit.newText } : {}),
        },
      };
    }
    case "write":
      return {
        name: "Write",
        args: {
          ...args,
          ...(typeof args.path === "string" ? { file_path: args.path } : {}),
        },
      };
    case "grep":
      return { name: "Grep", args };
    case "find":
      return { name: "Glob", args };
    case "ls":
      return {
        name: "Glob",
        args: {
          pattern: "*",
          ...args,
        },
      };
    default:
      return { name, args };
  }
}

/**
 * @param {Record<string, unknown>} args
 * @returns {{ oldText?: string, newText?: string }}
 */
function extractPiEditTexts(args) {
  if (!Array.isArray(args.edits) || args.edits.length !== 1 || !isObjectRecord(args.edits[0])) {
    return {};
  }
  const edit = args.edits[0];
  return {
    ...(typeof edit.oldText === "string" ? { oldText: edit.oldText } : {}),
    ...(typeof edit.newText === "string" ? { newText: edit.newText } : {}),
  };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} details
 * @returns {"add" | "update"}
 */
function inferPiFileChangeKind(name, args, details) {
  if (name === "write" && typeof args.content === "string" && typeof details.diff !== "string") {
    return "add";
  }
  return "update";
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} event
 * @returns {HarnessRuntimeEvent[]}
 */
function normalizePiFileChangeEvents(name, args, event) {
  if ((name !== "edit" && name !== "write") || typeof args.path !== "string") {
    return [];
  }
  const result = isObjectRecord(event.result) ? event.result : {};
  const details = isObjectRecord(result.details) ? result.details : {};
  const kind = inferPiFileChangeKind(name, args, details);
  return [{
    type: "file-change.completed",
    provider: "pi",
    change: {
      path: args.path,
      summary: `${args.path} (${kind})`,
      kind,
      ...(typeof details.diff === "string" ? { diff: details.diff } : {}),
      ...(name === "edit" ? extractPiEditTexts(args) : {}),
      ...(name === "write" && typeof args.content === "string" ? { newText: args.content } : {}),
    },
    raw: event,
  }];
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
    const displayTool = normalizePiToolForDisplay(toolStart.name, toolStart.args);
    return [{
      type: "tool.started",
      provider: "pi",
      tool: {
        id: toolStart.id,
        name: displayTool.name,
        arguments: displayTool.args,
      },
      raw: event,
    }];
  }

  if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
    const rawName = typeof event.toolName === "string" ? event.toolName : "tool";
    const displayTool = normalizePiToolForDisplay(rawName, isObjectRecord(event.args) ? event.args : {});
    return [{
      type: "tool.updated",
      provider: "pi",
      tool: {
        id: event.toolCallId,
        name: displayTool.name,
        arguments: displayTool.args,
        output: isObjectRecord(event.partialResult) ? extractToolResultText(event.partialResult) : undefined,
      },
      raw: event,
    }];
  }

  if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
    const rawName = typeof event.toolName === "string" ? event.toolName : "tool";
    const rawArgs = isObjectRecord(event.args) ? event.args : {};
    const displayTool = normalizePiToolForDisplay(rawName, rawArgs);
    const toolEvent = {
      type: event.isError === true ? "tool.failed" : "tool.completed",
      provider: "pi",
      tool: {
        id: event.toolCallId,
        name: displayTool.name,
        arguments: displayTool.args,
        output: isObjectRecord(event.result) ? extractToolResultText(event.result) : undefined,
      },
      raw: event,
    };
    if (event.isError === true) {
      return [/** @type {HarnessRuntimeEvent} */ (toolEvent)];
    }
    return [
      /** @type {HarnessRuntimeEvent} */ (toolEvent),
      ...normalizePiFileChangeEvents(rawName, rawArgs, event),
    ];
  }

  if (event.type === "agent_end") {
    return normalizeAgentEnd(event);
  }

  return [];
}

export { extractAssistantText, extractAssistantUsage, extractToolResultText, getResponseData };
