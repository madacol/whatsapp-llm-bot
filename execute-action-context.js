/**
 * Factories for creating ExecuteActionContext objects.
 */

/**
 * Create an ExecuteActionContext from an incoming WhatsApp message.
 * @param {IncomingContext} messageContext
 * @returns {ExecuteActionContext}
 */
export function createMessageActionContext(messageContext) {
  return {
    chatId: messageContext.chatId,
    senderIds: messageContext.senderIds,
    content: messageContext.content,
    getIsAdmin: messageContext.getIsAdmin,
    send: messageContext.send,
    reply: messageContext.reply,
    reactToMessage: messageContext.reactToMessage,
    select: messageContext.select,
    confirm: messageContext.confirm,
  };
}

/**
 * Create a silent no-op ExecuteActionContext for sub-agents and background tasks.
 * @param {string} chatId
 * @param {string[]} senderIds
 * @returns {ExecuteActionContext}
 */
export function createSilentActionContext(chatId, senderIds) {
  return {
    chatId,
    senderIds,
    content: [],
    getIsAdmin: async () => true,
    send: async (_source, _content) => undefined,
    reply: async (_source, _content) => undefined,
    reactToMessage: async () => {},
    select: async () => "",
    confirm: async () => true,
  };
}
