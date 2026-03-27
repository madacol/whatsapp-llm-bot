/**
 * Helpers for constructing semantic outbound adapter events.
 */

/**
 * @param {MessageSource} source
 * @param {SendContent} content
 * @returns {ContentEvent}
 */
export function contentEvent(source, content) {
  return { kind: "content", source, content };
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
 * @param {string} text
 * @returns {PlanEvent}
 */
export function planEvent(text) {
  return { kind: "plan", text };
}

/**
 * @param {{
 *   path: string,
 *   summary?: string,
 *   diff?: string,
 *   changeKind?: "add" | "delete" | "update",
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
    ...(input.oldText !== undefined && { oldText: input.oldText }),
    ...(input.newText !== undefined && { newText: input.newText }),
    ...(input.cwd !== undefined && { cwd: input.cwd }),
  };
}

/**
 * @param {string} cost
 * @param {{ prompt: number, completion: number, cached: number }} tokens
 * @returns {UsageEvent}
 */
export function usageEvent(cost, tokens) {
  return { kind: "usage", cost, tokens };
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
