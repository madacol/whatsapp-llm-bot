import { sendEvent as sendOutboundEvent } from "./send-content.js";
import { getOutboundQueuePersistDelayMs } from "../../whatsapp-outbound-queue-config.js";
import { makeTextMessage } from "../message-payloads.js";
import { enqueueWhatsAppOutbound } from "./queue-store.js";
import { createQueuedMessageHandle } from "./queued-handles.js";
import {
  flushQueuedWhatsAppOutbound,
  isRecoverableWhatsAppSendError,
} from "./queue-replay.js";

/** @type {Map<string, { text: string }>} */
const streamStates = new Map();

export {
  enqueueWhatsAppOutbound,
  flushQueuedWhatsAppOutbound,
  isRecoverableWhatsAppSendError,
};

/**
 * @param {ContentEvent} event
 * @returns {string}
 */
function extractStreamText(event) {
  const content = event.content;
  if (typeof content === "string") {
    return content;
  }
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
}

/**
 * @param {ContentEvent} event
 * @param {string} text
 * @returns {ContentEvent}
 */
function withStreamText(event, text) {
  const { stream: _stream, ...rest } = event;
  return {
    ...rest,
    content: [{ type: "markdown", text }],
  };
}

/**
 * @param {string} chatId
 * @param {string} streamId
 * @returns {string}
 */
function streamKey(chatId, streamId) {
  return `${chatId}\u0000${streamId}`;
}

/**
 * @param {string} chatId
 * @param {ContentEvent} event
 * @returns {ContentEvent | undefined}
 */
function bufferStreamEvent(chatId, event) {
  if (!event.stream) {
    return event;
  }
  const key = streamKey(chatId, event.stream.id);
  const state = streamStates.get(key) ?? { text: "" };
  const eventText = extractStreamText(event);
  state.text = event.stream.status === "final"
    ? eventText || state.text
    : `${state.text}${eventText}`;
  streamStates.set(key, state);

  if (event.stream.status !== "final") {
    return undefined;
  }

  streamStates.delete(key);
  return withStreamText(event, state.text);
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
  if (event.kind === "content" && event.stream) {
    const bufferedEvent = bufferStreamEvent(chatId, event);
    if (!bufferedEvent) {
      return undefined;
    }
    event = bufferedEvent;
  }

  const sock = getSocket();
  if (!sock) {
    return queueEventAfterDebouncedRetry({
      getSocket,
      chatId,
      event,
      reactionRuntime,
      store,
    });
  }

  try {
    return await sendOutboundEvent(sock, chatId, event, undefined, reactionRuntime, { editHandleStore: store });
  } catch (error) {
    if (!isRecoverableWhatsAppSendError(error)) {
      throw error;
    }
    return queueEventAfterDebouncedRetry({
      getSocket,
      chatId,
      event,
      reactionRuntime,
      store,
    });
  }
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
async function queueEventAfterDebouncedRetry({ getSocket, chatId, event, reactionRuntime, store }) {
  await wait(getOutboundQueuePersistDelayMs());
  const sock = getSocket();
  if (sock) {
    try {
      return await sendOutboundEvent(sock, chatId, event, undefined, reactionRuntime, { editHandleStore: store });
    } catch (error) {
      if (!isRecoverableWhatsAppSendError(error)) {
        throw error;
      }
    }
  }
  const row = await enqueueWhatsAppOutbound(chatId, { kind: "event", event }, store);
  return createQueuedMessageHandle(chatId, row.id);
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
    await queueTextAfterDebouncedRetry({ getSocket, chatId, text, store });
    return;
  }

  try {
    await sock.sendMessage(chatId, makeTextMessage(text));
  } catch (error) {
    if (!isRecoverableWhatsAppSendError(error)) {
      throw error;
    }
    await queueTextAfterDebouncedRetry({ getSocket, chatId, text, store });
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
async function queueTextAfterDebouncedRetry({ getSocket, chatId, text, store }) {
  await wait(getOutboundQueuePersistDelayMs());
  const sock = getSocket();
  if (sock) {
    try {
      await sock.sendMessage(chatId, makeTextMessage(text));
      return;
    } catch (error) {
      if (!isRecoverableWhatsAppSendError(error)) {
        throw error;
      }
    }
  }
  await enqueueWhatsAppOutbound(chatId, { kind: "text", text }, store);
}
