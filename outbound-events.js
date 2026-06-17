/**
 * Helpers for constructing semantic outbound adapter events.
 */

/**
 * @param {MessageSource} source
 * @param {SendContent} content
 * @param {{ cwd?: string | null, replyToTriggeringMessage?: boolean, stream?: ContentEvent["stream"] }} [options]
 * @returns {ContentEvent}
 */
export function contentEvent(source, content, options = {}) {
  return {
    kind: "content",
    source,
    content,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.replyToTriggeringMessage !== undefined && { replyToTriggeringMessage: options.replyToTriggeringMessage }),
    ...(options.stream !== undefined && { stream: options.stream }),
  };
}

/**
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {{ cwd?: string | null, displaySummary?: string, context?: ToolCallEvent["context"] }} [options]
 * @returns {ToolCallEvent}
 */
export function toolCallEvent(toolCall, options = {}) {
  return {
    kind: "tool_call",
    toolCall,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.displaySummary !== undefined && { displaySummary: options.displaySummary }),
    ...(options.context !== undefined && { context: options.context }),
  };
}

/**
 * @param {ToolActivitySummary} activity
 * @returns {ToolActivityEvent}
 */
export function toolActivityEvent(activity) {
  return { kind: "tool_activity", activity };
}

/**
 * @param {import("./plan-presentation.js").PlanPresentation} presentation
 * @returns {PlanEvent}
 */
export function planEvent(presentation) {
  return { kind: "plan", presentation };
}

/**
 * @param {string} cost
 * @param {UsageTokens} tokens
 * @returns {UsageEvent}
 */
export function usageEvent(cost, tokens) {
  return { kind: "usage", cost, tokens };
}

/**
 * @param {{
 *   text: string,
 *   threadId?: string,
 *   parentThreadId?: string,
 *   agentNickname?: string,
 *   agentRole?: string,
 * }} input
 * @returns {SubagentMessageEvent}
 */
export function subagentMessageEvent(input) {
  return {
    kind: "subagent_message",
    text: input.text,
    ...(input.threadId !== undefined && { threadId: input.threadId }),
    ...(input.parentThreadId !== undefined && { parentThreadId: input.parentThreadId }),
    ...(input.agentNickname !== undefined && { agentNickname: input.agentNickname }),
    ...(input.agentRole !== undefined && { agentRole: input.agentRole }),
  };
}

/**
 * Raw provider payloads are diagnostic side-channel material. Runtime
 * OutboundEvents carry only canonical app-owned fields.
 * @param {RuntimeEventOutboundEvent["event"]} event
 * @returns {RuntimeEventOutboundEvent["event"]}
 */
function canonicalRuntimeEvent(event) {
  const canonicalEvent = /** @type {Record<string, unknown>} */ ({ ...event });
  delete canonicalEvent.raw;
  delete canonicalEvent.diagnosticRaw;
  return /** @type {RuntimeEventOutboundEvent["event"]} */ (canonicalEvent);
}

/**
 * @param {RuntimeEventOutboundEvent["event"]} event
 * @param {{ cwd?: string | null }} [options]
 * @returns {RuntimeEventOutboundEvent}
 */
export function runtimeEvent(event, options = {}) {
  return {
    kind: "runtime_event",
    event: canonicalRuntimeEvent(event),
    ...(options.cwd !== undefined && { cwd: options.cwd }),
  };
}

/**
 * @param {ToolPresentation} presentation
 * @returns {MessageHandleUpdate}
 */
export function toolCallUpdate(presentation) {
  return { kind: "tool_call", presentation };
}

/**
 * @param {ToolFlowState} state
 * @returns {MessageHandleUpdate}
 */
export function toolFlowUpdate(state) {
  return { kind: "tool_flow", state };
}

/**
 * @param {string} text
 * @returns {MessageHandleUpdate}
 */
export function textUpdate(text) {
  return { kind: "text", text };
}

/**
 * @param {ToolPresentation} presentation
 * @param {string | undefined} [output]
 * @returns {MessageInspectState}
 */
export function toolInspectState(presentation, output) {
  return output === undefined
    ? { kind: "tool", presentation }
    : { kind: "tool", presentation, output };
}

/**
 * @param {ToolFlowState} state
 * @returns {MessageInspectState}
 */
export function toolFlowInspectState(state) {
  return { kind: "tool_flow", state };
}

/**
 * @param {string} summary
 * @param {string} text
 * @returns {MessageInspectState}
 */
export function reasoningInspectState(summary, text) {
  return { kind: "reasoning", summary, text };
}
