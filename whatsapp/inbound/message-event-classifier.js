/**
 * Transport-facing classifier for inbound WhatsApp message events.
 *
 * This keeps platform-only mechanics such as reactions and poll updates out of
 * the channel-input adapter so callers can reason in terms of semantic event kinds.
 */

/**
 * @typedef {{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string, senderIds?: string[], fromMe?: boolean }} NormalizedReactionEvent
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
 * @typedef {{ kind: "channel_input"; message: BaileysMessage }} ChannelInputMessageEvent
 */

/**
 * @typedef {IgnoreMessageEvent | ReactionMessageEvent | PollUpdateMessageEvent | ChannelInputMessageEvent} IncomingMessageEvent
 */

/**
 * @param {string | null | undefined} jid
 * @returns {string | null}
 */
function normalizeReactionSenderId(jid) {
  return typeof jid === "string" && jid.trim() ? jid.split("@")[0] : null;
}

/**
 * @param {string | null} id
 * @returns {id is string}
 */
function isReactionSenderId(id) {
  return typeof id === "string" && id.length > 0;
}

/**
 * @param {{ remoteJid?: string | null, participant?: string | null, participantAlt?: string | null }} key
 * @returns {string[]}
 */
function getReactionSenderIds(key) {
  const participantIds = [
    normalizeReactionSenderId(key.participant),
    normalizeReactionSenderId(key.participantAlt),
  ].filter(isReactionSenderId);
  const ids = participantIds.length > 0
    ? participantIds
    : [normalizeReactionSenderId(key.remoteJid)].filter(isReactionSenderId);
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.length > 0 ? uniqueIds : ["unknown"];
}

/**
 * @param {{ remoteJid?: string | null, participant?: string | null, participantAlt?: string | null }} key
 * @returns {{ senderId: string, senderIds?: string[] }}
 */
function getReactionSenderIdentity(key) {
  const senderIds = getReactionSenderIds(key);
  return {
    senderId: senderIds[0],
    ...(senderIds.length > 1 ? { senderIds } : {}),
  };
}

/**
 * Create the normalized payload used by reaction runtimes for the dedicated
 * `messages.reaction` event stream.
 * @param {Array<{
 *   key?: { id?: string | null, remoteJid?: string | null, participant?: string | null, participantAlt?: string | null, fromMe?: boolean | null };
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
      ...getReactionSenderIdentity(key),
      ...(typeof key.fromMe === "boolean" ? { fromMe: key.fromMe } : {}),
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
    ...getReactionSenderIdentity(/** @type {{ remoteJid?: string | null, participant?: string | null, participantAlt?: string | null }} */ (message.key)),
    ...(typeof message.key.fromMe === "boolean" ? { fromMe: message.key.fromMe } : {}),
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

  return { kind: "channel_input", message };
}
