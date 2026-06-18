/**
 * Helpers for message-handle updates and inspect state.
 */

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
