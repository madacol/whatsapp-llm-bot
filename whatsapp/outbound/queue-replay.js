import { createLogger } from "../../logger.js";
import { resolveOutputVisibility } from "../../chat-output-visibility.js";
import { getOutboundQueueReplayDelayMs } from "../../whatsapp-outbound-queue-config.js";
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
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function wait(ms) {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isBaileysRateOverlimitError(error) {
  const message = errorMessage(error);
  const stack = errorStack(error);
  return message === "rate-overlimit"
    && isObjectRecord(error)
    && error.data === 429
    && stack.includes("@whiskeysockets/baileys");
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRateLimitedWhatsAppSendError(error) {
  return isBaileysRateOverlimitError(error);
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
    || isRateLimitedWhatsAppSendError(error)
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
    || message.includes("WhatsApp transport has not been started")
    || isRateLimitedWhatsAppSendError(error);
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
  const chat = payload.event.kind === "runtime_event" ? await store?.getChat?.(chatId) : undefined;
  return sendOutboundEvent(sock, chatId, payload.event, payload.options, reactionRuntime, {
    editHandleStore: store,
    ...(chat ? { outputVisibility: resolveOutputVisibility(chat.output_visibility) } : {}),
  });
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
 *   store?: import("../../store.js").Store,
 *   replayDelayMs?: number,
 *   sleepFn?: (ms: number) => Promise<void>,
 * }} input
 * @returns {Promise<DeliveredWhatsAppOutboundRow[]>}
 */
export async function flushQueuedWhatsAppOutbound({ getSocket, reactionRuntime, store, replayDelayMs, sleepFn }) {
  const queuedRows = await listQueuedWhatsAppOutbound(store);
  /** @type {DeliveredWhatsAppOutboundRow[]} */
  const deliveredRows = [];
  const delayMs = replayDelayMs ?? getOutboundQueueReplayDelayMs();
  const sleep = sleepFn ?? wait;

  for (const row of queuedRows) {
    if (deliveredRows.length > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

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
