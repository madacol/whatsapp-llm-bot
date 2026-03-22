/**
 * Factories for creating ExecuteActionContext objects.
 */

/**
 * Create an ExecuteActionContext from a normalized chat turn.
 * @param {ChatTurn} turn
 * @returns {ExecuteActionContext}
 */
export function createMessageActionContext(turn) {
  return {
    chatId: turn.chatId,
    senderIds: turn.senderIds,
    content: turn.content,
    getIsAdmin: turn.io.getIsAdmin,
    send: turn.io.send,
    reply: turn.io.reply,
    reactToMessage: turn.io.react,
    select: turn.io.select,
    confirm: turn.io.confirm,
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
    send: async (_event) => undefined,
    reply: async (_event) => undefined,
    reactToMessage: async () => {},
    select: async () => "",
    confirm: async () => true,
  };
}
