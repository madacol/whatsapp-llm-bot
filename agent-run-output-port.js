import {
  contentEvent,
  planEvent,
  runtimeEvent,
  subagentMessageEvent,
  toolCallEvent,
  usageEvent,
} from "./outbound-events.js";
import { createOutboundEventSink } from "./outbound-event-sink.js";

/**
 * Agent-run output port for Agent Run Activity.
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @param {{ cwd?: string | null }} [defaults]
 * @returns {AgentRunOutputPort}
 */
export function createAgentRunOutputPort(context, defaults = {}) {
  const sink = createOutboundEventSink(context);

  /**
   * @param {{ cwd?: string | null } | undefined} options
   * @returns {{ cwd?: string | null }}
   */
  function withDefaultCwd(options) {
    const cwd = options?.cwd ?? defaults.cwd;
    return cwd !== undefined && cwd !== null ? { cwd } : {};
  }

  return {
    sendRuntimeEvent: (event, options) => sink.send(runtimeEvent(event, withDefaultCwd(options))),
    sendToolCall: (toolCall, options = {}) => sink.send(toolCallEvent(toolCall, {
      ...withDefaultCwd(options),
      ...(options.displaySummary !== undefined && { displaySummary: options.displaySummary }),
      ...(options.context !== undefined && { context: options.context }),
    })),
    replyWithAssistantOutput: (content, options = {}) => sink.reply(contentEvent("llm", content, {
      ...withDefaultCwd(options),
      ...(options.stream !== undefined && { stream: options.stream }),
    })),
    replyWithThinking: () => sink.reply(contentEvent("llm", [{ type: "text", text: "Thinking..." }])),
    replyWithSubagentMessage: (input) => sink.reply(subagentMessageEvent(input)),
    sendToolResult: (content, options) => sink.send(contentEvent("tool-result", content, withDefaultCwd(options))),
    sendError: (message) => sink.send(contentEvent("error", message)),
    replyWithError: (message) => sink.reply(contentEvent("error", message)),
    replyWithPlan: (presentation) => sink.reply(planEvent(presentation)),
    sendUsage: (cost, tokens) => sink.send(usageEvent(cost, tokens)),
  };
}
