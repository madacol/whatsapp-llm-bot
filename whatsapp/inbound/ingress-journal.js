export const WHATSAPP_INGRESS_SOURCE_UPSERT = "messages.upsert";
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
 * @returns {value is { kind: "messages.upsert", message: BaileysMessage } | { kind: "messages.reaction", reactions: unknown[] }}
 */
export function isWhatsAppIngressPayload(value) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === WHATSAPP_INGRESS_SOURCE_UPSERT) {
    return isRecord(value.message);
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
