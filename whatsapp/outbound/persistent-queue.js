import { getRootDb } from "../../db.js";
import { initStore } from "../../store.js";
import { createLogger } from "../../logger.js";
import { sendEvent as sendOutboundEvent } from "./send-content.js";

const log = createLogger("whatsapp");
/** @type {Promise<import("../../store.js").Store> | null} */
let storePromise = null;
/** @type {import("@electric-sql/pglite").PGlite | null} */
let storeDb = null;

/**
 * @typedef {{
 *   kind: "event";
 *   event: OutboundEvent;
 * } | {
 *   kind: "text";
 *   text: string;
 * }} WhatsAppOutboundQueuePayload
 */

/**
 * @typedef {{
 *   id: number;
 *   chatId: string;
 *   payload: WhatsAppOutboundQueuePayload;
 * }} QueuedWhatsAppOutboundRow
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is MessageSource}
 */
function isMessageSource(value) {
  return value === "llm"
    || value === "tool-call"
    || value === "tool-result"
    || value === "error"
    || value === "warning"
    || value === "usage"
    || value === "memory"
    || value === "plain";
}

/**
 * @param {unknown} value
 * @returns {value is ToolContentBlock}
 */
function isToolContentBlock(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
    case "markdown":
      return typeof value.text === "string";
    case "code":
      return typeof value.code === "string"
        && (value.caption === undefined || typeof value.caption === "string");
    case "diff":
      return typeof value.oldStr === "string"
        && typeof value.newStr === "string"
        && (value.language === undefined || typeof value.language === "string")
        && (value.caption === undefined || typeof value.caption === "string")
        && (value.diffText === undefined || typeof value.diffText === "string");
    case "image":
      return typeof value.mime_type === "string"
        && (value.alt === undefined || typeof value.alt === "string")
        && (value.quality === undefined || value.quality === "standard" || value.quality === "hd")
        && (value._hdParentMessageId === undefined || typeof value._hdParentMessageId === "string")
        && (
          value._hdRef === undefined
          || value._hdRef === null
          || (
            isRecord(value._hdRef)
            && typeof value._hdRef.mediaKey === "string"
            && (value._hdRef.url === undefined || typeof value._hdRef.url === "string")
            && (value._hdRef.directPath === undefined || typeof value._hdRef.directPath === "string")
            && (value._hdRef.mimetype === undefined || typeof value._hdRef.mimetype === "string")
          )
        )
        && (value.getHd === undefined)
        && (
          (value.encoding === "base64" && typeof value.data === "string")
          || (typeof value.path === "string" && (value.sha256 === undefined || typeof value.sha256 === "string"))
        );
    case "video":
      return (value.mime_type === undefined || typeof value.mime_type === "string")
        && (value.alt === undefined || typeof value.alt === "string")
        && (
          (value.encoding === "base64" && typeof value.data === "string")
          || (typeof value.path === "string" && (value.sha256 === undefined || typeof value.sha256 === "string"))
        );
    case "audio":
      return (value.mime_type === undefined || typeof value.mime_type === "string")
        && (
          (value.encoding === "base64" && typeof value.data === "string")
          || (typeof value.path === "string" && (value.sha256 === undefined || typeof value.sha256 === "string"))
        );
    case "file":
      return (value.mime_type === undefined || typeof value.mime_type === "string")
        && (value.file_name === undefined || typeof value.file_name === "string")
        && (value.caption === undefined || typeof value.caption === "string")
        && (
          (value.encoding === "base64" && typeof value.data === "string")
          || (typeof value.path === "string" && (value.sha256 === undefined || typeof value.sha256 === "string"))
        );
    default:
      return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is SendContent}
 */
function isSendContent(value) {
  if (typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isToolContentBlock);
  }
  return isToolContentBlock(value);
}

/**
 * @param {unknown} value
 * @returns {value is OutboundEvent}
 */
function isOutboundEvent(value) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  switch (value.kind) {
    case "content":
      return isMessageSource(value.source) && isSendContent(value.content);
    case "tool_call":
      return isRecord(value.presentation);
    case "tool_activity":
      return isRecord(value.activity);
    case "plan":
      return isRecord(value.presentation);
    case "file_change":
      return typeof value.path === "string"
        && (value.summary === undefined || typeof value.summary === "string")
        && (value.diff === undefined || typeof value.diff === "string")
        && (value.changeKind === undefined || value.changeKind === "add" || value.changeKind === "delete" || value.changeKind === "update")
        && (value.oldText === undefined || typeof value.oldText === "string")
        && (value.newText === undefined || typeof value.newText === "string")
        && (value.cwd === undefined || value.cwd === null || typeof value.cwd === "string");
    case "usage":
      return typeof value.cost === "string"
        && isRecord(value.tokens)
        && typeof value.tokens.prompt === "number"
        && typeof value.tokens.completion === "number"
        && typeof value.tokens.cached === "number";
    default:
      return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is WhatsAppOutboundQueuePayload}
 */
function isWhatsAppOutboundQueuePayload(value) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  switch (value.kind) {
    case "event":
      return isOutboundEvent(value.event);
    case "text":
      return typeof value.text === "string";
    default:
      return false;
  }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeRowId(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {QueuedWhatsAppOutboundRow | null}
 */
function normalizeQueuedRow(value) {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeRowId(value.id);
  if (id === null || typeof value.chat_id !== "string" || !isWhatsAppOutboundQueuePayload(value.payload_json)) {
    return null;
  }

  return {
    id,
    chatId: value.chat_id,
    payload: value.payload_json,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @returns {Promise<import("../../store.js").Store>}
 */
async function getStore() {
  const currentRootDb = getRootDb();
  if (!storePromise || storeDb !== currentRootDb) {
    storeDb = currentRootDb;
    storePromise = initStore(currentRootDb);
  }
  return storePromise;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRecoverableWhatsAppSendError(error) {
  const message = errorMessage(error);
  return message.includes("Connection Closed")
    || message.includes("Connection was lost")
    || message.includes("WhatsApp socket is not connected")
    || message.includes("WhatsApp transport has not been started");
}

/**
 * @param {string} chatId
 * @param {WhatsAppOutboundQueuePayload} payload
 * @param {import("../../store.js").Store} [store]
 * @returns {Promise<void>}
 */
export async function enqueueWhatsAppOutbound(chatId, payload, store) {
  const resolvedStore = store ?? await getStore();
  await resolvedStore.enqueueWhatsAppOutboundQueueEntry({
    chatId,
    payloadJson: payload,
  });
}

/**
 * @param {number} id
 * @param {import("../../store.js").Store} [store]
 * @returns {Promise<void>}
 */
async function deleteQueuedWhatsAppOutbound(id, store) {
  const resolvedStore = store ?? await getStore();
  await resolvedStore.deleteWhatsAppOutboundQueueEntry(id);
}

/**
 * @param {import("../../store.js").Store} [store]
 * @returns {Promise<QueuedWhatsAppOutboundRow[]>}
 */
async function listQueuedWhatsAppOutbound(store) {
  const resolvedStore = store ?? await getStore();
  const rows = await resolvedStore.listWhatsAppOutboundQueueEntries();

  /** @type {QueuedWhatsAppOutboundRow[]} */
  const normalized = [];
  for (const row of rows) {
    const normalizedRow = normalizeQueuedRow(row);
    if (!normalizedRow) {
      const rowId = isRecord(row) ? normalizeRowId(row.id) : null;
      log.error("Dropping malformed WhatsApp outbound queue row.", { row });
      if (rowId !== null) {
        await deleteQueuedWhatsAppOutbound(rowId, resolvedStore);
      }
      continue;
    }
    normalized.push(normalizedRow);
  }
  return normalized;
}

/**
 * @param {import("@whiskeysockets/baileys").WASocket} sock
 * @param {string} chatId
 * @param {WhatsAppOutboundQueuePayload} payload
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @returns {Promise<MessageHandle | undefined>}
 */
async function deliverQueuedPayload(sock, chatId, payload, reactionRuntime) {
  if (payload.kind === "text") {
    await sock.sendMessage(chatId, { text: payload.text });
    return undefined;
  }
  return sendOutboundEvent(sock, chatId, payload.event, undefined, reactionRuntime);
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   chatId: string,
 *   event: OutboundEvent,
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<MessageHandle | undefined>}
 */
export async function sendOrQueueWhatsAppEvent({ getSocket, chatId, event, reactionRuntime, store }) {
  const sock = getSocket();
  if (!sock) {
    await enqueueWhatsAppOutbound(chatId, { kind: "event", event }, store);
    return undefined;
  }

  try {
    return await sendOutboundEvent(sock, chatId, event, undefined, reactionRuntime);
  } catch (error) {
    if (!isRecoverableWhatsAppSendError(error)) {
      throw error;
    }
    await enqueueWhatsAppOutbound(chatId, { kind: "event", event }, store);
    return undefined;
  }
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   chatId: string,
 *   text: string,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<void>}
 */
export async function sendOrQueueWhatsAppText({ getSocket, chatId, text, store }) {
  const sock = getSocket();
  if (!sock) {
    await enqueueWhatsAppOutbound(chatId, { kind: "text", text }, store);
    return;
  }

  try {
    await sock.sendMessage(chatId, { text });
  } catch (error) {
    if (!isRecoverableWhatsAppSendError(error)) {
      throw error;
    }
    await enqueueWhatsAppOutbound(chatId, { kind: "text", text }, store);
  }
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<void>}
 */
export async function flushQueuedWhatsAppOutbound({ getSocket, reactionRuntime, store }) {
  const queuedRows = await listQueuedWhatsAppOutbound(store);

  for (const row of queuedRows) {
    const sock = getSocket();
    if (!sock) {
      return;
    }

    try {
      await deliverQueuedPayload(sock, row.chatId, row.payload, reactionRuntime);
      await deleteQueuedWhatsAppOutbound(row.id, store);
    } catch (error) {
      if (isRecoverableWhatsAppSendError(error)) {
        return;
      }

      log.error("Dropping unrecoverable WhatsApp outbound queue row.", {
        rowId: row.id,
        chatId: row.chatId,
        error,
      });
      await deleteQueuedWhatsAppOutbound(row.id);
    }
  }
}
