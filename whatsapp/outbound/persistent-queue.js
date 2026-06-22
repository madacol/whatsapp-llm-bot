import { sendEvent as sendOutboundEvent } from "./send-content.js";
import { resolveOutputVisibility } from "../../chat-output-visibility.js";
import { getOutboundQueuePersistDelayMs } from "../../whatsapp-outbound-queue-config.js";
import { buildWhatsAppTextDeliveryPlan } from "./delivery-plan.js";
import { executeWhatsAppDeliveryPlan } from "./delivery-plan-executor.js";
import { enqueueWhatsAppOutbound } from "./queue-store.js";
import { createQueuedMessageHandle } from "./queued-handles.js";
import {
  flushQueuedWhatsAppOutbound,
  isRateLimitedWhatsAppSendError,
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
 * @param {AssistantOutputEvent} event
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
 * @param {AssistantOutputEvent} event
 * @param {string} text
 * @returns {AssistantOutputEvent}
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
 * @param {AssistantOutputEvent} event
 * @returns {AssistantOutputEvent | undefined}
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
 * @param {string} chatId
 * @param {import("../../store.js").Store | undefined} store
 * @returns {Promise<import("../../chat-output-visibility.js").OutputVisibility | undefined>}
 */
async function resolveQueuedOutputVisibility(chatId, store) {
  const chat = await store?.getChat?.(chatId);
  return chat ? resolveOutputVisibility(chat.output_visibility) : undefined;
}

/**
 * @param {string} chatId
 * @param {OutboundEvent} event
 * @param {import("../../store.js").Store | undefined} store
 * @returns {Promise<{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility }>}
 */
async function buildWhatsAppSendOptions(chatId, event, store) {
  return {
    editHandleStore: store,
    ...(event.kind === "runtime_event" ? { outputVisibility: await resolveQueuedOutputVisibility(chatId, store) } : {}),
  };
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   chatId: string,
 *   event: OutboundEvent,
 *   options?: { quoted?: import("@whiskeysockets/baileys").WAMessage },
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<MessageHandle | undefined>}
 */
export async function sendOrQueueWhatsAppEvent({ getSocket, chatId, event, options, reactionRuntime, store }) {
  if (event.kind === "assistant_output" && event.stream) {
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
      options,
      reactionRuntime,
      store,
    });
  }

  try {
    return await sendOutboundEvent(sock, chatId, event, options, reactionRuntime, await buildWhatsAppSendOptions(chatId, event, store));
  } catch (error) {
    if (!isRecoverableWhatsAppSendError(error)) {
      throw error;
    }
    if (isRateLimitedWhatsAppSendError(error)) {
      const row = await enqueueWhatsAppOutbound(chatId, { kind: "event", event, ...(options ? { options } : {}) }, store);
      return createQueuedMessageHandle(chatId, row.id);
    }
    return queueEventAfterDebouncedRetry({
      getSocket,
      chatId,
      event,
      options,
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
 *   options?: { quoted?: import("@whiskeysockets/baileys").WAMessage },
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<MessageHandle | undefined>}
 */
async function queueEventAfterDebouncedRetry({ getSocket, chatId, event, options, reactionRuntime, store }) {
  await wait(getOutboundQueuePersistDelayMs());
  const sock = getSocket();
  if (sock) {
    try {
      return await sendOutboundEvent(sock, chatId, event, options, reactionRuntime, await buildWhatsAppSendOptions(chatId, event, store));
    } catch (error) {
      if (!isRecoverableWhatsAppSendError(error)) {
        throw error;
      }
    }
  }
  const row = await enqueueWhatsAppOutbound(chatId, { kind: "event", event, ...(options ? { options } : {}) }, store);
  return createQueuedMessageHandle(chatId, row.id);
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   chatId: string,
 *   text: string,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<"sent" | "queued">}
 */
export async function sendOrQueueWhatsAppText({ getSocket, chatId, text, store }) {
  const sock = getSocket();
  if (!sock) {
    return queueTextAfterDebouncedRetry({ getSocket, chatId, text, store });
  }

  try {
    await executeWhatsAppDeliveryPlan(sock, chatId, buildWhatsAppTextDeliveryPlan({ text }));
    return "sent";
  } catch (error) {
    if (!isRecoverableWhatsAppSendError(error)) {
      throw error;
    }
    if (isRateLimitedWhatsAppSendError(error)) {
      await enqueueWhatsAppOutbound(chatId, { kind: "text", text }, store);
      return "queued";
    }
    return queueTextAfterDebouncedRetry({ getSocket, chatId, text, store });
  }
}

/**
 * @param {{
 *   getSocket: () => import("@whiskeysockets/baileys").WASocket | null,
 *   chatId: string,
 *   text: string,
 *   store?: import("../../store.js").Store,
 * }} input
 * @returns {Promise<"sent" | "queued">}
 */
async function queueTextAfterDebouncedRetry({ getSocket, chatId, text, store }) {
  await wait(getOutboundQueuePersistDelayMs());
  const sock = getSocket();
  if (sock) {
    try {
      await executeWhatsAppDeliveryPlan(sock, chatId, buildWhatsAppTextDeliveryPlan({ text }));
      return "sent";
    } catch (error) {
      if (!isRecoverableWhatsAppSendError(error)) {
        throw error;
      }
    }
  }
  await enqueueWhatsAppOutbound(chatId, { kind: "text", text }, store);
  return "queued";
}
