import { sendEvent as sendOutboundEvent } from "./send-content.js";
import { resolveOutputVisibility } from "../../chat-output-visibility.js";
import {
  getOutboundQueuePersistDelayMs,
  getOutboundQueueReplayDelayMs,
} from "../../whatsapp-outbound-queue-config.js";
import { buildWhatsAppTextDeliveryPlan } from "./delivery-plan.js";
import { executeWhatsAppDeliveryPlan } from "./delivery-plan-executor.js";
import {
  deleteQueuedWhatsAppOutbound,
  enqueueWhatsAppOutbound,
  getWhatsAppOutboundStore,
  listQueuedWhatsAppOutbound,
} from "./queue-store.js";
import {
  createQueuedMessageHandle,
  resolveQueuedHandle,
} from "./queued-handles.js";
import { createLogger } from "../../logger.js";

const log = createLogger("whatsapp");

/**
 * @typedef {{
 *   chatId: string;
 *   queueId: number;
 *   handle: MessageHandle | undefined;
 * }} DeliveredWhatsAppOutboundRow
 *
 * @typedef {{
 *   getSocket?: () => WhatsAppOutboundSocketPort | null,
 *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
 *   store?: import("../../store.js").Store,
 *   persistDelayMs?: number,
 *   replayDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   deliverEvent?: (
 *     sock: WhatsAppOutboundSocketPort,
 *     chatId: string,
 *     event: OutboundEvent,
 *     options: { quoted?: import("@whiskeysockets/baileys").WAMessage } | undefined,
 *     reactionRuntime: import("../runtime/reaction-runtime.js").ReactionRuntime | undefined,
 *     sendOptions: { editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility },
 *   ) => Promise<MessageHandle | undefined>,
 *   deliverText?: (
 *     sock: WhatsAppOutboundSocketPort,
 *     chatId: string,
 *     text: string,
 *   ) => Promise<MessageHandle | undefined>,
 *   enqueueOutbound?: (
 *     chatId: string,
 *     payload: import("./queue-store.js").WhatsAppOutboundQueuePayload,
 *     store?: import("../../store.js").Store,
 *   ) => Promise<{ id: number }>,
 *   listQueuedOutbound?: (
 *     store?: import("../../store.js").Store,
 *   ) => Promise<import("./queue-store.js").QueuedWhatsAppOutboundRow[]>,
 *   deleteQueuedOutbound?: (
 *     chatId: string,
 *     id: number,
 *     store?: import("../../store.js").Store,
 *   ) => Promise<void>,
 *   createQueuedHandle?: (chatId: string, queueId: number) => MessageHandle,
 *   resolveQueuedHandle?: (chatId: string, queueId: number, handle: MessageHandle | undefined) => void,
 * }} WhatsAppOutboundDurabilityDeps
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
 * @param {{ keepStream?: boolean }} [options]
 * @returns {AssistantOutputEvent}
 */
function withStreamText(event, text, options = {}) {
  if (options.keepStream) {
    return {
      ...event,
      content: [{ type: "markdown", text }],
    };
  }
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
 * @param {number | undefined} explicitDelayMs
 * @param {() => number} fallback
 * @returns {number}
 */
function resolveDelayMs(explicitDelayMs, fallback) {
  return typeof explicitDelayMs === "number" ? explicitDelayMs : fallback();
}

/**
 * @param {WhatsAppOutboundDurabilityDeps} defaults
 * @param {WhatsAppOutboundDurabilityDeps} overrides
 * @returns {Required<Pick<WhatsAppOutboundDurabilityDeps,
 *   "sleep" | "deliverEvent" | "deliverText" | "enqueueOutbound" | "listQueuedOutbound" | "deleteQueuedOutbound" | "createQueuedHandle" | "resolveQueuedHandle"
 * >> & WhatsAppOutboundDurabilityDeps}
 */
function resolveDeps(defaults, overrides) {
  return {
    ...defaults,
    ...overrides,
    sleep: overrides.sleep ?? defaults.sleep ?? wait,
    deliverEvent: overrides.deliverEvent ?? defaults.deliverEvent ?? sendOutboundEvent,
    deliverText: overrides.deliverText ?? defaults.deliverText ?? (async (sock, chatId, text) => {
      const result = await executeWhatsAppDeliveryPlan(sock, chatId, buildWhatsAppTextDeliveryPlan({ text }));
      if (!result.lastEditableKey) {
        return undefined;
      }
      return {
        deliveryStatus: "sent",
        messageKey: result.lastEditableKey,
        update: async () => {},
        setInspect: () => {},
      };
    }),
    enqueueOutbound: overrides.enqueueOutbound ?? defaults.enqueueOutbound ?? enqueueWhatsAppOutbound,
    listQueuedOutbound: overrides.listQueuedOutbound ?? defaults.listQueuedOutbound ?? listQueuedWhatsAppOutbound,
    deleteQueuedOutbound: overrides.deleteQueuedOutbound ?? defaults.deleteQueuedOutbound ?? deleteQueuedWhatsAppOutbound,
    createQueuedHandle: overrides.createQueuedHandle ?? defaults.createQueuedHandle ?? createQueuedMessageHandle,
    resolveQueuedHandle: overrides.resolveQueuedHandle ?? defaults.resolveQueuedHandle ?? resolveQueuedHandle,
  };
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
 * @param {import("../../store.js").Store | undefined} store
 * @returns {Promise<{ editHandleStore?: import("../../store.js").Store, outputVisibility?: import("../../chat-output-visibility.js").OutputVisibility }>}
 */
async function buildWhatsAppSendOptions(chatId, store) {
  return {
    editHandleStore: store,
    outputVisibility: await resolveQueuedOutputVisibility(chatId, store),
  };
}

/**
 * @param {WhatsAppOutboundDurabilityDeps} [defaults]
 */
export function createWhatsAppOutboundDurability(defaults = {}) {
  /** @type {Map<string, { text: string }>} */
  const streamStates = new Map();

  /**
   * @param {string} chatId
   * @param {AssistantOutputEvent} event
   * @param {{ emitPartial?: boolean }} [options]
   * @returns {AssistantOutputEvent | undefined}
   */
  function bufferStreamEvent(chatId, event, options = {}) {
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

    if (event.stream.status !== "final" && !options.emitPartial) {
      return undefined;
    }

    if (event.stream.status === "final") {
      streamStates.delete(key);
    }
    return withStreamText(event, state.text, { keepStream: options.emitPartial });
  }

  /**
   * @param {{
   *   getSocket?: () => WhatsAppOutboundSocketPort | null,
   *   chatId: string,
   *   event: OutboundEvent,
   *   options?: { quoted?: import("@whiskeysockets/baileys").WAMessage },
   *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
   *   store?: import("../../store.js").Store,
   * }} input
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function sendOrQueueEvent(input) {
    const deps = resolveDeps(defaults, input);
    const getSocket = deps.getSocket;
    if (!getSocket) {
      throw new Error("WhatsApp outbound durability requires a socket accessor.");
    }
    let event = input.event;
    const sendOptions = await buildWhatsAppSendOptions(input.chatId, input.store ?? deps.store);
    if (event.kind === "assistant_output" && event.stream) {
      const shouldEmitPartialStream = sendOptions.outputVisibility?.middleAssistantMessages === "pinned";
      const bufferedEvent = bufferStreamEvent(input.chatId, event, { emitPartial: shouldEmitPartialStream });
      if (!bufferedEvent) {
        return undefined;
      }
      event = bufferedEvent;
    }

    const sock = getSocket();
    if (!sock) {
      return queueEventAfterDebouncedRetry({ ...input, event }, deps);
    }

    try {
      return await deps.deliverEvent(
        sock,
        input.chatId,
        event,
        input.options,
        input.reactionRuntime ?? deps.reactionRuntime,
        sendOptions,
      );
    } catch (error) {
      if (!isRecoverableWhatsAppSendError(error)) {
        throw error;
      }
      if (isRateLimitedWhatsAppSendError(error)) {
        const row = await deps.enqueueOutbound(input.chatId, { kind: "event", event, ...(input.options ? { options: input.options } : {}) }, input.store ?? deps.store);
        return deps.createQueuedHandle(input.chatId, row.id);
      }
      return queueEventAfterDebouncedRetry({ ...input, event }, deps);
    }
  }

  /**
   * @param {{
   *   getSocket?: () => WhatsAppOutboundSocketPort | null,
   *   chatId: string,
   *   event: OutboundEvent,
   *   options?: { quoted?: import("@whiskeysockets/baileys").WAMessage },
   *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
   *   store?: import("../../store.js").Store,
   * }} input
   * @param {ReturnType<typeof resolveDeps>} deps
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function queueEventAfterDebouncedRetry(input, deps) {
    const getSocket = deps.getSocket;
    if (!getSocket) {
      throw new Error("WhatsApp outbound durability requires a socket accessor.");
    }
    await deps.sleep(resolveDelayMs(deps.persistDelayMs, getOutboundQueuePersistDelayMs));
    const sock = getSocket();
    if (sock) {
      try {
        return await deps.deliverEvent(
          sock,
          input.chatId,
          input.event,
          input.options,
          input.reactionRuntime ?? deps.reactionRuntime,
          await buildWhatsAppSendOptions(input.chatId, input.store ?? deps.store),
        );
      } catch (error) {
        if (!isRecoverableWhatsAppSendError(error)) {
          throw error;
        }
      }
    }
    const row = await deps.enqueueOutbound(input.chatId, { kind: "event", event: input.event, ...(input.options ? { options: input.options } : {}) }, input.store ?? deps.store);
    return deps.createQueuedHandle(input.chatId, row.id);
  }

  /**
   * @param {{
   *   getSocket?: () => WhatsAppOutboundSocketPort | null,
   *   chatId: string,
   *   text: string,
   *   store?: import("../../store.js").Store,
   * }} input
   * @returns {Promise<"sent" | "queued">}
   */
  async function sendOrQueueText(input) {
    const deps = resolveDeps(defaults, input);
    const getSocket = deps.getSocket;
    if (!getSocket) {
      throw new Error("WhatsApp outbound durability requires a socket accessor.");
    }
    const sock = getSocket();
    if (!sock) {
      return queueTextAfterDebouncedRetry(input, deps);
    }

    try {
      await deps.deliverText(sock, input.chatId, input.text);
      return "sent";
    } catch (error) {
      if (!isRecoverableWhatsAppSendError(error)) {
        throw error;
      }
      if (isRateLimitedWhatsAppSendError(error)) {
        await deps.enqueueOutbound(input.chatId, { kind: "text", text: input.text }, input.store ?? deps.store);
        return "queued";
      }
      return queueTextAfterDebouncedRetry(input, deps);
    }
  }

  /**
   * @param {{
   *   getSocket?: () => WhatsAppOutboundSocketPort | null,
   *   chatId: string,
   *   text: string,
   *   store?: import("../../store.js").Store,
   * }} input
   * @param {ReturnType<typeof resolveDeps>} deps
   * @returns {Promise<"sent" | "queued">}
   */
  async function queueTextAfterDebouncedRetry(input, deps) {
    const getSocket = deps.getSocket;
    if (!getSocket) {
      throw new Error("WhatsApp outbound durability requires a socket accessor.");
    }
    await deps.sleep(resolveDelayMs(deps.persistDelayMs, getOutboundQueuePersistDelayMs));
    const sock = getSocket();
    if (sock) {
      try {
        await deps.deliverText(sock, input.chatId, input.text);
        return "sent";
      } catch (error) {
        if (!isRecoverableWhatsAppSendError(error)) {
          throw error;
        }
      }
    }
    await deps.enqueueOutbound(input.chatId, { kind: "text", text: input.text }, input.store ?? deps.store);
    return "queued";
  }

  /**
   * @param {WhatsAppOutboundSocketPort} sock
   * @param {string} chatId
   * @param {import("./queue-store.js").WhatsAppOutboundQueuePayload} payload
   * @param {import("../runtime/reaction-runtime.js").ReactionRuntime | undefined} reactionRuntime
   * @param {import("../../store.js").Store | undefined} store
   * @param {ReturnType<typeof resolveDeps>} deps
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function deliverQueuedPayload(sock, chatId, payload, reactionRuntime, store, deps) {
    if (payload.kind === "text") {
      return deps.deliverText(sock, chatId, payload.text);
    }
    return deps.deliverEvent(sock, chatId, payload.event, payload.options, reactionRuntime, {
      editHandleStore: store,
      ...(await buildWhatsAppSendOptions(chatId, store)),
    });
  }

  /**
   * @param {{
   *   getSocket?: () => WhatsAppOutboundSocketPort | null,
   *   reactionRuntime?: import("../runtime/reaction-runtime.js").ReactionRuntime,
   *   store?: import("../../store.js").Store,
   *   replayDelayMs?: number,
   *   sleepFn?: (ms: number) => Promise<void>,
   * }} [input]
   * @returns {Promise<DeliveredWhatsAppOutboundRow[]>}
   */
  async function flushQueued(input = {}) {
    const deps = resolveDeps(defaults, {
      ...input,
      ...(input.sleepFn ? { sleep: input.sleepFn } : {}),
    });
    const getSocket = deps.getSocket;
    if (!getSocket) {
      throw new Error("WhatsApp outbound durability requires a socket accessor.");
    }
    const queuedRows = await deps.listQueuedOutbound(input.store ?? deps.store);
    /** @type {DeliveredWhatsAppOutboundRow[]} */
    const deliveredRows = [];
    const delayMs = input.replayDelayMs ?? resolveDelayMs(deps.replayDelayMs, getOutboundQueueReplayDelayMs);

    for (const row of queuedRows) {
      if (deliveredRows.length > 0 && delayMs > 0) {
        await deps.sleep(delayMs);
      }

      const sock = getSocket();
      if (!sock) {
        return deliveredRows;
      }

      try {
        const handle = await deliverQueuedPayload(sock, row.chatId, row.payload, input.reactionRuntime ?? deps.reactionRuntime, input.store ?? deps.store, deps);
        deps.resolveQueuedHandle(row.chatId, row.id, handle);
        deliveredRows.push({ chatId: row.chatId, queueId: row.id, handle });
        await deps.deleteQueuedOutbound(row.chatId, row.id, input.store ?? deps.store);
      } catch (error) {
        if (isConnectionRecoverableWhatsAppSendError(error)) {
          return deliveredRows;
        }

        log.error("Quarantining WhatsApp outbound queue row.", {
          rowId: row.id,
          chatId: row.chatId,
          error,
        });
        await (input.store ?? deps.store ?? await getWhatsAppOutboundStore()).quarantineWhatsAppOutboundQueueEntry({
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

  return {
    sendOrQueueEvent,
    sendOrQueueText,
    flushQueued,
  };
}

const defaultDurability = createWhatsAppOutboundDurability();

/**
 * @param {Parameters<ReturnType<typeof createWhatsAppOutboundDurability>["sendOrQueueEvent"]>[0]} input
 */
export function sendOrQueueWhatsAppEvent(input) {
  return defaultDurability.sendOrQueueEvent(input);
}

/**
 * @param {Parameters<ReturnType<typeof createWhatsAppOutboundDurability>["sendOrQueueText"]>[0]} input
 */
export function sendOrQueueWhatsAppText(input) {
  return defaultDurability.sendOrQueueText(input);
}

/**
 * @param {Parameters<ReturnType<typeof createWhatsAppOutboundDurability>["flushQueued"]>[0]} input
 */
export function flushQueuedWhatsAppOutbound(input) {
  return defaultDurability.flushQueued(input);
}
