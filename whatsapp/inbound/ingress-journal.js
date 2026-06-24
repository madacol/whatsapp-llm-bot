export const WHATSAPP_INGRESS_SOURCE_UPSERT = "messages.upsert";
export const WHATSAPP_INGRESS_SOURCE_UPDATE = "messages.update";
export const WHATSAPP_INGRESS_SOURCE_REACTION = "messages.reaction";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {BaileysMessage} message
 * @returns {string}
 */
export function getMessageChatId(message) {
  return message.key.remoteJid || "unknown-chat";
}

/**
 * @param {BaileysMessage} message
 * @returns {string}
 */
export function createUpsertIngressKey(message) {
  const chatId = getMessageChatId(message);
  const messageId = message.key.id || String(message.messageTimestamp ?? "missing-id");
  const participant = message.key.participant || "";
  const direction = message.key.fromMe ? "from-me" : "from-user";
  return `${WHATSAPP_INGRESS_SOURCE_UPSERT}:${chatId}:${messageId}:${participant}:${direction}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatPollSelectedOption(value) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  return typeof value === "string" ? value : "";
}

/**
 * @param {unknown} update
 * @returns {string}
 */
function getPollUpdateIdentity(update) {
  if (!isRecord(update) || !isRecord(update.pollUpdateMessageKey)) {
    return "missing-poll-update-key";
  }
  const key = update.pollUpdateMessageKey;
  const messageId = typeof key.id === "string" ? key.id : "missing-id";
  const participant = typeof key.participant === "string" ? key.participant : "";
  const remoteJid = typeof key.remoteJid === "string" ? key.remoteJid : "";
  const selectedOptions = isRecord(update.vote) && Array.isArray(update.vote.selectedOptions)
    ? update.vote.selectedOptions.map(formatPollSelectedOption).join("+")
    : "";
  const senderTimestampMs = typeof update.senderTimestampMs === "number" || typeof update.senderTimestampMs === "string"
    ? update.senderTimestampMs
    : "";
  return `${remoteJid}:${messageId}:${participant}:${selectedOptions}:${senderTimestampMs}`;
}

/**
 * @param {import('@whiskeysockets/baileys').WAMessageUpdate} update
 * @returns {{ chatId: string, ingressKey: string }}
 */
export function createMessageUpdateIngressIdentity(update) {
  const chatId = update.key.remoteJid || "unknown-chat";
  const messageId = update.key.id || "missing-id";
  const pollUpdates = update.update.pollUpdates ?? [];
  const pollUpdateIds = pollUpdates.map(getPollUpdateIdentity).join(",");
  return {
    chatId,
    ingressKey: `${WHATSAPP_INGRESS_SOURCE_UPDATE}:${chatId}:${messageId}:${pollUpdateIds || "no-poll-updates"}`,
  };
}

/**
 * @param {unknown} event
 * @param {number} index
 * @returns {{ chatId: string, ingressKey: string }}
 */
export function createReactionIngressIdentity(event, index) {
  if (isRecord(event) && isRecord(event.key)) {
    const key = event.key;
    const chatId = typeof key.remoteJid === "string" ? key.remoteJid : "unknown-chat";
    const messageId = typeof key.id === "string" ? key.id : `missing-id-${index}`;
    const participant = typeof key.participant === "string" ? key.participant : "";
    const emoji = isRecord(event.reaction) && typeof event.reaction.text === "string" ? event.reaction.text : "";
    return {
      chatId,
      ingressKey: `${WHATSAPP_INGRESS_SOURCE_REACTION}:${chatId}:${messageId}:${participant}:${emoji}:${index}`,
    };
  }
  return {
    chatId: "unknown-chat",
    ingressKey: `${WHATSAPP_INGRESS_SOURCE_REACTION}:unknown:${index}:${Date.now()}`,
  };
}

/**
 * @param {unknown} value
 * @returns {value is { kind: "messages.upsert", message: BaileysMessage } | { kind: "messages.update", update: import('@whiskeysockets/baileys').WAMessageUpdate } | { kind: "messages.reaction", reactions: unknown[] }}
 */
export function isWhatsAppIngressPayload(value) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === WHATSAPP_INGRESS_SOURCE_UPSERT) {
    return isRecord(value.message);
  }
  if (value.kind === WHATSAPP_INGRESS_SOURCE_UPDATE) {
    return isRecord(value.update);
  }
  return value.kind === WHATSAPP_INGRESS_SOURCE_REACTION && Array.isArray(value.reactions);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function formatIngressError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}
