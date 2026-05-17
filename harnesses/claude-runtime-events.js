/**
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeAssistantCompletedEvent} HarnessRuntimeAssistantCompletedEvent
 * @typedef {import("./harness-runtime-events.js").HarnessRuntimeUsage} HarnessRuntimeUsage
 */

/**
 * SDK BetaMessage.usage extended with cache fields from the Anthropic API.
 * @typedef {{
 *   input_tokens?: number,
 *   output_tokens?: number,
 *   cache_read_input_tokens?: number,
 *   cache_creation_input_tokens?: number,
 * }} ClaudeUsageWithCache
 */

/**
 * Check whether an SDK event originates from a sub-agent.
 * Sub-agent events have a non-null `parent_tool_use_id` pointing to the Agent
 * tool call that spawned them.
 * @param {{ parent_tool_use_id?: string | null }} event
 * @returns {boolean}
 */
export function isClaudeSubagentEvent(event) {
  return event.parent_tool_use_id != null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {ClaudeUsageWithCache}
 */
function readUsage(value) {
  if (!isObjectRecord(value)) {
    return {};
  }
  return {
    ...(typeof value.input_tokens === "number" ? { input_tokens: value.input_tokens } : {}),
    ...(typeof value.output_tokens === "number" ? { output_tokens: value.output_tokens } : {}),
    ...(typeof value.cache_read_input_tokens === "number"
      ? { cache_read_input_tokens: value.cache_read_input_tokens }
      : {}),
    ...(typeof value.cache_creation_input_tokens === "number"
      ? { cache_creation_input_tokens: value.cache_creation_input_tokens }
      : {}),
  };
}

/**
 * @param {unknown} value
 * @param {number} cost
 * @returns {HarnessRuntimeUsage | undefined}
 */
function toRuntimeUsage(value, cost) {
  const usage = readUsage(value);
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  const cachedTokens = usage.cache_read_input_tokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0 && cachedTokens === 0 && cost === 0) {
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    cost,
  };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function readErrorMessages(value) {
  if (!isObjectRecord(value) || !Array.isArray(value.errors)) {
    return [];
  }
  return value.errors.filter(
    /**
     * @param {unknown} error
     * @returns {error is string}
     */
    (error) => typeof error === "string",
  );
}

/**
 * Build a debug label for an SDK event.
 * @param {import("@anthropic-ai/claude-agent-sdk").SDKMessage} event
 * @returns {string}
 */
export function getClaudeSdkEventLabel(event) {
  if (event.type === "assistant" && event.message?.content) {
    const toolBlock = event.message.content.find((block) => block.type === "tool_use");
    if (toolBlock) {
      const input = isObjectRecord(toolBlock.input) ? toolBlock.input : {};
      const inputSummary = String(
        input.command
          ?? input.file_path
          ?? input.pattern
          ?? input.query
          ?? input.prompt
          ?? input.description
          ?? "",
      ).slice(0, 80);
      return `tool_use:${toolBlock.name}(${inputSummary})`;
    }
  }
  return event.type;
}

/**
 * @param {unknown} block
 * @returns {block is { type: "text", text: string }}
 */
function isTextBlock(block) {
  return isObjectRecord(block) && block.type === "text" && typeof block.text === "string";
}

/**
 * @param {unknown} block
 * @returns {block is { type: "tool_use", id: string, name: string, input?: unknown }}
 */
function isToolUseBlock(block) {
  return isObjectRecord(block)
    && block.type === "tool_use"
    && typeof block.id === "string"
    && typeof block.name === "string";
}

/**
 * Normalize a Claude assistant SDK event into runtime presentation events and
 * the assistant message blocks that should be persisted for main-agent turns.
 * @param {import("@anthropic-ai/claude-agent-sdk").SDKAssistantMessage} event
 * @returns {{
 *   runtimeEvents: HarnessRuntimeAssistantCompletedEvent[],
 *   storedBlocks: (TextContentBlock | ToolCallContentBlock)[],
 *   shouldPersist: boolean,
 * }}
 */
export function normalizeClaudeAssistantEvent(event) {
  const isSubagent = isClaudeSubagentEvent(event);
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const usage = toRuntimeUsage(event.message?.usage, 0);
  /** @type {HarnessRuntimeAssistantCompletedEvent[]} */
  const runtimeEvents = [];
  /** @type {(TextContentBlock | ToolCallContentBlock)[]} */
  const storedBlocks = [];
  let usageAttached = false;

  for (const block of content) {
    if (isTextBlock(block)) {
      runtimeEvents.push({
        type: "assistant.completed",
        provider: "claude-agent-sdk",
        text: block.text,
        ...(isSubagent ? { displayText: `*Agent:* ${block.text}` } : {}),
        contentType: "text",
        responseMode: isSubagent ? "none" : "append",
        ...(usage && !usageAttached ? { usage, usageMode: "add" } : {}),
        raw: event,
      });
      usageAttached = true;
      storedBlocks.push({ type: "text", text: block.text });
      continue;
    }

    if (isToolUseBlock(block)) {
      storedBlocks.push({
        type: "tool",
        tool_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }

  if (usage && !usageAttached) {
    runtimeEvents.push({
      type: "assistant.completed",
      provider: "claude-agent-sdk",
      text: "",
      contentType: "text",
      responseMode: "none",
      notify: false,
      usage,
      usageMode: "add",
      raw: event,
    });
  }

  return {
    runtimeEvents,
    storedBlocks,
    shouldPersist: !isSubagent && storedBlocks.length > 0,
  };
}

/**
 * @param {import("@anthropic-ai/claude-agent-sdk").SDKResultMessage} event
 * @returns {{
 *   runtimeEvent: HarnessRuntimeAssistantCompletedEvent | null,
 *   errorMessages: string[],
 * }}
 */
export function normalizeClaudeResultEvent(event) {
  const usage = toRuntimeUsage(
    event.usage,
    typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0,
  );
  /** @type {HarnessRuntimeAssistantCompletedEvent | null} */
  const runtimeEvent = !event.is_error && "result" in event && typeof event.result === "string"
    ? {
        type: "assistant.completed",
        provider: "claude-agent-sdk",
        text: event.result,
        contentType: "text",
        responseMode: "replace",
        ...(usage ? { usage, usageMode: "replace" } : {}),
        raw: event,
      }
    : usage
      ? {
          type: "assistant.completed",
          provider: "claude-agent-sdk",
          text: "",
          contentType: "text",
          responseMode: "none",
          notify: false,
          usage,
          usageMode: "replace",
          raw: event,
        }
      : null;

  const errorMessages = event.is_error ? readErrorMessages(event) : [];

  return {
    runtimeEvent,
    errorMessages,
  };
}
