/**
 * Render semantic OutboundEvent variants into transport-level message source
 * and content pairs.
 */

import { parseToolArgs } from "../../agent-io-defaults.js";
import { formatPlanPresentationText } from "../../plan-presentation.js";
import { formatUsageEventText } from "../../usage-formatting.js";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { renderToolActivityContent, renderToolPresentationContent } from "../tool-presenter.js";

/**
 * @typedef {{ source: MessageSource, content: SendContent, cwd?: string | null }} RenderedOutboundEvent
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
 * @param {TranscriptionStatusEvent} event
 * @returns {RenderedOutboundEvent}
 */
export function renderTranscriptionStatusEvent(event) {
  return {
    source: event.status === "failed" ? "error" : "plain",
    content: event.detail ? `${event.summary}\n\n${event.detail}` : event.summary,
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

/**
 * @param {AgentErrorEvent} event
 * @returns {{ source: MessageSource, content: SendContent }}
 */
export function renderAgentErrorEvent(event) {
  return {
    source: "error",
    content: event.message,
  };
}

/**
 * @param {ToolCallEvent} event
 * @returns {ToolPresentation | null}
 */
export function buildToolPresentationFromToolCallEvent(event) {
  const args = parseToolArgs(event.toolCall.arguments);
  const formatToolCall = typeof event.displaySummary === "string"
    ? () => event.displaySummary ?? ""
    : undefined;
  return buildToolPresentation(
    event.toolCall.name,
    args,
    formatToolCall,
    event.cwd ?? null,
    event.context,
  );
}

/**
 * @param {ToolCallEvent} event
 * @returns {RenderedOutboundEvent | null}
 */
export function renderToolCallEvent(event) {
  const presentation = buildToolPresentationFromToolCallEvent(event);
  return presentation
    ? { source: "tool-call", content: renderToolPresentationContent(presentation) }
    : null;
}

/**
 * @param {ToolActivityEvent} event
 * @returns {RenderedOutboundEvent | null}
 */
export function renderToolActivityEvent(event) {
  return event.activity.title === "stdin" && event.activity.lines.length === 0
    ? null
    : { source: "tool-call", content: renderToolActivityContent(event.activity) };
}

/**
 * @param {PlanEvent} event
 * @returns {RenderedOutboundEvent}
 */
export function renderPlanEvent(event) {
  return {
    source: "llm",
    content: [{ type: "markdown", text: formatPlanPresentationText(event.presentation) }],
  };
}

/**
 * @param {UsageEvent} event
 * @returns {RenderedOutboundEvent}
 */
export function renderUsageEvent(event) {
  return {
    source: "usage",
    content: formatUsageEventText(event),
  };
}

/**
 * @param {SubagentMessageEvent} event
 * @returns {SendContent}
 */
function renderSubagentMessageContent(event) {
  const title = event.agentNickname
    ? `**Sub-agent ${event.agentNickname}**`
    : "**Sub-agent**";
  const detail = event.agentRole ? `_${event.agentRole}_` : "";
  return [{ type: "markdown", text: [`🧩 ${title}`, detail, event.text].filter(Boolean).join("\n") }];
}

/**
 * @param {SubagentMessageEvent} event
 * @returns {RenderedOutboundEvent}
 */
export function renderSubagentMessageEvent(event) {
  return {
    source: "plain",
    content: renderSubagentMessageContent(event),
  };
}
