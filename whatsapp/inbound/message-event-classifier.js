/**
 * Transport-facing classifier for inbound WhatsApp message events.
 *
 * This keeps platform-only mechanics such as reactions and poll updates out of
 * the chat-turn adapter so callers can reason in terms of semantic event kinds.
 */

/**
 * @typedef {{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string }} NormalizedReactionEvent
 */

/**
 * @typedef {{ kind: "ignore" }} IgnoreMessageEvent
 */

/**
 * @typedef {{ kind: "reaction"; reactions: NormalizedReactionEvent[] }} ReactionMessageEvent
 */

/**
 * @typedef {{ kind: "poll_update"; message: BaileysMessage }} PollUpdateMessageEvent
 */

/**
 * @typedef {{ kind: "turn"; message: BaileysMessage }} TurnMessageEvent
 */

/**
 * @typedef {IgnoreMessageEvent | ReactionMessageEvent | PollUpdateMessageEvent | TurnMessageEvent} IncomingMessageEvent
 */

/**
 * @param {{ remoteJid?: string | null, participant?: string | null, participantAlt?: string | null }} key
 * @returns {string}
 */
function getReactionSenderId(key) {
  return (key.participant || key.participantAlt || key.remoteJid || "unknown").split("@")[0];
}

/**
 * Create the normalized payload used by reaction runtimes for the dedicated
 * `messages.reaction` event stream.
 * @param {Array<{
 *   key?: { id?: string | null, remoteJid?: string | null, participant?: string | null, participantAlt?: string | null };
 *   reaction?: { text?: string | null };
 * }>} events
 * @returns {NormalizedReactionEvent[]}
 */
export function normalizeReactionEvents(events) {
  /** @type {NormalizedReactionEvent[]} */
  const normalized = [];

  for (const event of events) {
    const { key, reaction } = event;
    if (!key?.id || !key.remoteJid || !reaction?.text) {
      continue;
    }

    normalized.push({
      key: { id: key.id, remoteJid: key.remoteJid },
      reaction: { text: reaction.text },
      senderId: getReactionSenderId(key),
    });
  }

  return normalized;
}

/**
 * Normalize a reaction that arrived as a `messages.upsert` payload instead of
 * the dedicated `messages.reaction` event stream.
 * @param {BaileysMessage} message
 * @returns {NormalizedReactionEvent[]}
 */
export function normalizeUpsertReactionMessage(message) {
  const reactionMessage = message.message?.reactionMessage;
  const reactedKey = reactionMessage?.key;
  if (!reactedKey?.id || !reactionMessage?.text) {
    return [];
  }

  const remoteJid = reactedKey.remoteJid || message.key.remoteJid;
  if (!remoteJid) {
    return [];
  }

  return [{
    key: { id: reactedKey.id, remoteJid },
    reaction: { text: reactionMessage.text },
    senderId: getReactionSenderId(/** @type {{ remoteJid?: string | null, participant?: string | null, participantAlt?: string | null }} */ (message.key)),
  }];
}

/**
 * Classify an inbound `messages.upsert` payload into the semantic event kind
 * the transport should handle.
 * @param {BaileysMessage} message
 * @returns {IncomingMessageEvent}
 */
export function classifyIncomingMessageEvent(message) {
  if (message.key.remoteJid === "status@broadcast" || !message.message) {
    return { kind: "ignore" };
  }

  const reactions = normalizeUpsertReactionMessage(message);
  if (reactions.length > 0) {
    return { kind: "reaction", reactions };
  }

  if (message.message.pollUpdateMessage) {
    return { kind: "poll_update", message };
  }

  return { kind: "turn", message };
}
