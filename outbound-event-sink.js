/**
 * Infrastructure seam for delivering already-created OutboundEvents.
 * Domain producers should prefer AppOutputPort or AgentRunOutputPort.
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @returns {OutboundEventSink}
 */
export function createOutboundEventSink(context) {
  return {
    send: (event) => context.send(event),
    reply: (event) => context.reply(event),
  };
}
