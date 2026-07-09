/**
 * Helpers for constructing outbound adapter events.
 */

/**
 * @param {AppMessageEvent["role"]} role
 * @param {SendContent} content
 * @param {{
 *   replyToTriggeringMessage?: boolean,
 *   presentationCategory?: AppMessageEvent["presentationCategory"],
 *   presentationStatus?: AppMessageEvent["presentationStatus"],
 * }} [options]
 * @returns {AppMessageEvent}
 */
export function appMessageEvent(role, content, options = {}) {
  return {
    kind: "app_message",
    role,
    content,
    ...(options.replyToTriggeringMessage !== undefined && { replyToTriggeringMessage: options.replyToTriggeringMessage }),
    ...(options.presentationCategory !== undefined && { presentationCategory: options.presentationCategory }),
    ...(options.presentationStatus !== undefined && { presentationStatus: options.presentationStatus }),
  };
}

/**
 * @param {SendContent} content
 * @param {{ cwd?: string | null, stream?: AssistantOutputEvent["stream"] }} [options]
 * @returns {AssistantOutputEvent}
 */
export function assistantOutputEvent(content, options = {}) {
  return {
    kind: "assistant_output",
    content,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.stream !== undefined && { stream: options.stream }),
  };
}

/**
 * @param {SendContent} content
 * @param {{ cwd?: string | null }} [options]
 * @returns {AgentToolResultEvent}
 */
export function agentToolResultEvent(content, options = {}) {
  return {
    kind: "agent_tool_result",
    content,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
  };
}

/**
 * @param {string} message
 * @returns {AgentErrorEvent}
 */
export function agentErrorEvent(message) {
  return {
    kind: "agent_error",
    message,
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
 * @param {RuntimeEventOutboundEvent["event"]} event
 * @param {{ cwd?: string | null }} [options]
 * @returns {RuntimeEventOutboundEvent}
 */
export function runtimeEvent(event, options = {}) {
  return {
    kind: "runtime_event",
    event,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
  };
}
