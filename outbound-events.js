/**
 * Helpers for constructing semantic outbound adapter events.
 */

/**
 * @param {MessageSource} source
 * @param {SendContent} content
 * @param {{ cwd?: string | null, stream?: ContentEvent["stream"] }} [options]
 * @returns {ContentEvent}
 */
export function contentEvent(source, content, options = {}) {
  return {
    kind: "content",
    source,
    content,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.stream !== undefined && { stream: options.stream }),
  };
}

/**
 * @param {import("./tool-presentation-model.js").ToolPresentation} presentation
 * @returns {ToolCallEvent}
 */
export function toolCallEvent(presentation) {
  return { kind: "tool_call", presentation };
}

/**
 * @param {import("./tool-presentation-model.js").ToolActivitySummary} activity
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
 * @param {{
 *   path: string,
 *   summary?: string,
 *   diff?: string,
 *   changeKind?: "add" | "delete" | "update",
 *   itemId?: string,
 *   stage?: "proposed" | "denied" | "applied" | "failed",
 *   oldText?: string,
 *   newText?: string,
 *   cwd?: string | null,
 * }} input
 * @returns {FileChangeEvent}
 */
export function fileChangeEvent(input) {
  return {
    kind: "file_change",
    path: input.path,
    ...(input.summary !== undefined && { summary: input.summary }),
    ...(input.diff !== undefined && { diff: input.diff }),
    ...(input.changeKind !== undefined && { changeKind: input.changeKind }),
    ...(input.itemId !== undefined && { itemId: input.itemId }),
    ...(input.stage !== undefined && { stage: input.stage }),
    ...(input.oldText !== undefined && { oldText: input.oldText }),
    ...(input.newText !== undefined && { newText: input.newText }),
    ...(input.cwd !== undefined && { cwd: input.cwd }),
  };
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
 * @param {import("./harnesses/harness-runtime-events.js").HarnessRuntimeEvent} event
 * @returns {RuntimeEventOutboundEvent}
 */
export function runtimeEvent(event) {
  return { kind: "runtime_event", event };
}

/**
 * @param {import("./tool-presentation-model.js").ToolPresentation} presentation
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
 * @param {import("./tool-presentation-model.js").ToolPresentation} presentation
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
