import { appMessageEvent } from "./outbound-events.js";
import { createOutboundEventSink } from "./outbound-event-sink.js";

/**
 * App-owned output port for Turn Orchestration and app command modules.
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @returns {AppOutputPort}
 */
export function createAppOutputPort(context) {
  const sink = createOutboundEventSink(context);
  return {
    replyWithToolResult: (content) => sink.reply(appMessageEvent("tool_result", content)),
    replyWithError: (message) => sink.reply(appMessageEvent("error", message)),
    replyWithPlain: (content, options = {}) => sink.reply(appMessageEvent("plain", content, options)),
    sendPlain: (content) => sink.send(appMessageEvent("plain", content)),
    sendMemory: (content) => sink.send(appMessageEvent("memory", content)),
    replyWithFileChange: (change) => sink.reply({ kind: "file_change", ...change }),
  };
}
