import { createLogger } from "../../logger.js";
import { makeTextMessage } from "../message-payloads.js";
import { sendEvent as sendOutboundEvent } from "./send-content.js";
import {
  deleteQueuedWhatsAppOutbound,
  getWhatsAppOutboundStore,
  listQueuedWhatsAppOutbound,
} from "./queue-store.js";
import { resolveQueuedHandle } from "./queued-handles.js";

const log = createLogger("whatsapp");

/**
 * @typedef {{
 *   chatId: string;
 *   queueId: number;
 *   handle: MessageHandle | undefined;
 * }} DeliveredWhatsAppOutboundRow
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorStack(error) {
  return error instanceof Error && typeof error.stack === "string" ? error.stack : "";
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRecoverableWhatsAppSendError(error) {
  const message = errorMessage(error);
  const stack = errorStack(error);
  return message.includes("Connection Closed")
    || message.includes("Connection Terminated")
    || message.includes("Connection was lost")
    || message.trim() === "1006"
    || message.includes("WhatsApp socket is not connected")
    || message.includes("WhatsApp transport has not been started")
    || (message.includes("Cannot read properties of undefined (reading 'attrs')")
      && stack.includes("@whiskeysockets/baileys")
      && stack.includes("/Socket/groups.js"));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isConnectionRecoverableWhatsAppSendError(error) {
  const message = errorMessage(error);
  return message.includes("Connection Closed")
    || message.includes("Connection Terminated")
    || message.includes("Connection was lost")
    || message.trim() === "1006"
    || message.includes("WhatsApp socket is not connected")
    || message.includes("WhatsApp transport has not been started");
}

/**
 * @param {import("@whiskeysockets/baileys").WASocket} sock
 * @param {string} chatId
 * @param {import("./queue-store.js").WhatsAppOutboundQueuePayload} payload
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
 * @param {import("../../store.js").Store | undefined} store
 * @returns {Promise<MessageHandle | undefined>}
 */
async function deliverQueuedPayload(sock, chatId, payload, reactionRuntime, store) {
  if (payload.kind === "text") {
    await sock.sendMessage(chatId, makeTextMessage(payload.text));
    return undefined;
  }
  return sendOutboundEvent(sock, chatId, payload.event, undefined, reactionRuntime, { editHandleStore: store });
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<DeliveredWhatsAppOutboundRow[]>}
 */
export async function flushQueuedWhatsAppOutbound({ getSocket, reactionRuntime, store }) {
  const queuedRows = await listQueuedWhatsAppOutbound(store);
  /** @type {DeliveredWhatsAppOutboundRow[]} */
  const deliveredRows = [];

  for (const row of queuedRows) {
    const sock = getSocket();
    if (!sock) {
      return deliveredRows;
    }

    try {
      const handle = await deliverQueuedPayload(sock, row.chatId, row.payload, reactionRuntime, store);
      resolveQueuedHandle(row.chatId, row.id, handle);
      deliveredRows.push({ chatId: row.chatId, queueId: row.id, handle });
      await deleteQueuedWhatsAppOutbound(row.chatId, row.id, store);
    } catch (error) {
      if (isConnectionRecoverableWhatsAppSendError(error)) {
        return deliveredRows;
      }

      log.error("Quarantining WhatsApp outbound queue row.", {
        rowId: row.id,
        chatId: row.chatId,
        error,
      });
      await (store ?? await getWhatsAppOutboundStore()).quarantineWhatsAppOutboundQueueEntry({
        row: {
          id: row.id,
          chat_id: row.chatId,
          payload_json: row.payload,
        },
        reason: errorMessage(error),
      });
    }
  }

  return deliveredRows;
}
