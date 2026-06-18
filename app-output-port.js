import { contentEvent } from "./outbound-events.js";
import { createOutboundEventSink } from "./outbound-event-sink.js";

/**
 * App-owned output port for Turn Orchestration and app command modules.
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @returns {AppOutputPort}
 */
export function createAppOutputPort(context) {
  const sink = createOutboundEventSink(context);
  return {
    replyWithToolResult: (content) => sink.reply(contentEvent("tool-result", content)),
    replyWithError: (message) => sink.reply(contentEvent("error", message)),
    replyWithPlain: (content, options = {}) => sink.reply(contentEvent("plain", content, options)),
    sendPlain: (content) => sink.send(contentEvent("plain", content)),
    sendMemory: (content) => sink.send(contentEvent("memory", content)),
    replyWithFileChange: (change) => sink.reply({ kind: "file_change", ...change }),
  };
}
