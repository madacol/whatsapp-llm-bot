/**
 * @typedef {{
 *   display_name: string | null,
 *   sender_id: string,
 *   sender_jid: string | null,
 * }} UserIdentityResult
 */

/**
 * @param {{
 *   senderId: string | undefined,
 *   senderJid: string | undefined,
 *   displayName: string | undefined,
 * }} input
 * @returns {UserIdentityResult | null}
 */
function buildIdentityResult({ senderId, senderJid, displayName }) {
  if (typeof senderId !== "string" || senderId.length === 0) {
    return null;
  }
  return {
    display_name: typeof displayName === "string" && displayName.length > 0 ? displayName : null,
    sender_id: senderId,
    sender_jid: typeof senderJid === "string" && senderJid.length > 0 ? senderJid : null,
  };
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "get_user_identity",
  description: "Retrieve the WhatsApp identity for the current sender or the sender of the quoted message in this turn.",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["current", "quoted"],
        description: "Which sender identity to retrieve. Use 'quoted' only when the current message replies to another message.",
      },
    },
  },
  formatToolCall: ({ target }) => target === "quoted" ? "Getting quoted user identity" : "Getting current user identity",
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  action_fn: async function (context, { target }) {
    if (target === "quoted") {
      return buildIdentityResult({
        senderId: context.quotedSenderId,
        senderJid: context.quotedSenderJid,
        displayName: context.quotedSenderName,
      });
    }

    return buildIdentityResult({
      senderId: context.senderIds[0],
      senderJid: Array.isArray(context.senderJids) ? context.senderJids[0] : undefined,
      displayName: context.senderName,
    });
  },
});
