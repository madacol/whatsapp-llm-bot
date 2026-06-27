/**
 * Resolve app-owned Channel identity while preserving legacy chatId inputs at
 * transport and storage edges.
 * @param {{ channelId?: string, chatId: string }} input
 * @returns {string}
 */
export function getChannelId(input) {
  return typeof input.channelId === "string" && input.channelId.trim()
    ? input.channelId
    : input.chatId;
}

/**
 * Attach Channel vocabulary to a value that still carries legacy chatId for
 * compatibility.
 * @template {Record<string, unknown> & { chatId: string }} T
 * @param {T} input
 * @returns {T & { channelId: string }}
 */
export function withChannelIdentity(input) {
  return {
    ...input,
    channelId: getChannelId(input),
  };
}
