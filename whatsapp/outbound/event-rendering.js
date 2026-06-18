/**
 * Render semantic OutboundEvent variants into transport-level message source
 * and content pairs.
 */

/**
 * @param {AppMessageEvent["role"]} role
 * @returns {MessageSource}
 */
export function appMessageRoleToSource(role) {
  switch (role) {
    case "tool_result":
      return "tool-result";
    case "error":
      return "error";
    case "memory":
      return "memory";
    case "plain":
      return "plain";
    default:
      return "plain";
  }
}

/**
 * @param {AppMessageEvent} event
 * @returns {{ source: MessageSource, content: SendContent }}
 */
export function renderAppMessageEvent(event) {
  return {
    source: appMessageRoleToSource(event.role),
    content: event.content,
  };
}

/**
 * @param {AssistantOutputEvent} event
 * @returns {{ source: MessageSource, content: SendContent, cwd?: string | null }}
 */
export function renderAssistantOutputEvent(event) {
  return {
    source: "llm",
    content: event.content,
    ...(event.cwd !== undefined && { cwd: event.cwd }),
  };
}

/**
 * @param {AgentToolResultEvent} event
 * @returns {{ source: MessageSource, content: SendContent, cwd?: string | null }}
 */
export function renderAgentToolResultEvent(event) {
  return {
    source: "tool-result",
    content: event.content,
    ...(event.cwd !== undefined && { cwd: event.cwd }),
  };
}
