import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createRuntimeDiagnosticsState } from "../../diagnostics-config.js";
import { createFixtureCapture } from "../../diagnostics/capture.js";
import {
  captureWhatsAppMessageUpdateEvent,
  captureWhatsAppUpsertEvent,
  createWhatsAppTransport,
} from "../../whatsapp/create-whatsapp-transport.js";

/** @typedef {Partial<import("@whiskeysockets/baileys").BaileysEventMap>} BaileysEvents */
/** @typedef {(events: BaileysEvents) => Promise<void>} BaileysEventHandler */

/**
 * @typedef {{
 *   id: string,
 *   chatId: string,
 *   message: Record<string, unknown>,
 * }} SentWhatsAppMessage
 */

/**
 * @typedef {{
 *   botPhoneJid?: string,
 *   botLidJid?: string,
 *   inboundCoalesceDelayMs?: number,
 *   store?: import("../../store.js").Store,
 * }} WhatsAppTransportTestbedOptions
 */

/**
 * @param {() => boolean} predicate
 * @param {string} failureMessage
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export async function waitForCondition(predicate, failureMessage, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail(failureMessage);
}

/**
 * @param {SentWhatsAppMessage[]} sentMessages
 * @param {string} text
 * @returns {boolean}
 */
export function hasSentTextContaining(sentMessages, text) {
  return sentMessages.some((entry) =>
    typeof entry.message.text === "string"
    && entry.message.text.includes(text));
}

/**
 * @param {SentWhatsAppMessage[]} sentMessages
 * @param {(text: string) => boolean} predicate
 * @returns {string}
 */
export function findSentTextMessageId(sentMessages, predicate) {
  const entry = sentMessages.find((message) =>
    typeof message.message.text === "string"
    && predicate(message.message.text));
  assert.ok(entry, `Expected sent text message, got ${JSON.stringify(sentMessages)}`);
  return entry.id;
}

/**
 * @param {{
 *   chatId: string,
 *   text: string,
 *   senderId: string,
 *   id?: string,
 *   senderName?: string,
 *   timestamp?: number,
 * }} input
 * @returns {import("@whiskeysockets/baileys").WAMessage}
 */
export function whatsappTextMessage({
  chatId,
  text,
  senderId,
  id = "MSG-VERTICAL-TEXT-1",
  senderName = "Vertical User",
  timestamp = 1782322700,
}) {
  return /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
    key: {
      remoteJid: chatId,
      fromMe: false,
      id,
      senderLid: `${senderId}-lid@lid`,
    },
    message: {
      conversation: text,
    },
    messageTimestamp: timestamp,
    pushName: senderName,
  }));
}

/**
 * @param {{
 *   chatId: string,
 *   targetMessageId: string,
 *   reaction: string,
 *   senderLidJid: string,
 *   senderPhoneJid?: string,
 *   id?: string,
 *   timestamp?: number,
 *   targetParticipantJid?: string,
 * }} input
 * @returns {import("@whiskeysockets/baileys").WAMessage}
 */
export function whatsappReactionMessage({
  chatId,
  targetMessageId,
  reaction,
  senderLidJid,
  senderPhoneJid,
  id = "MSG-VERTICAL-REACTION-1",
  timestamp = 1782322730,
  targetParticipantJid,
}) {
  return /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
    key: {
      remoteJid: chatId,
      fromMe: false,
      id,
      participant: senderLidJid,
      ...(senderPhoneJid ? { participantAlt: senderPhoneJid } : {}),
      addressingMode: "lid",
    },
    messageTimestamp: timestamp,
    message: {
      reactionMessage: {
        key: {
          remoteJid: chatId,
          fromMe: true,
          id: targetMessageId,
          ...(targetParticipantJid ? { participant: targetParticipantJid } : {}),
        },
        text: reaction,
        senderTimestampMs: timestamp * 1_000,
      },
    },
  }));
}

/**
 * @param {{
 *   chatId: string,
 *   targetMessageId: string,
 *   reaction: string,
 *   id?: string,
 *   timestamp?: number,
 *   targetParticipantJid?: string,
 * }} input
 * @returns {import("@whiskeysockets/baileys").WAMessage}
 */
export function whatsappGroupOnlyReactionMessage({
  chatId,
  targetMessageId,
  reaction,
  id = "MSG-VERTICAL-GROUP-ONLY-REACTION-1",
  timestamp = 1782322730,
  targetParticipantJid,
}) {
  return /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
    key: {
      remoteJid: chatId,
      fromMe: false,
      id,
    },
    messageTimestamp: timestamp,
    message: {
      reactionMessage: {
        key: {
          remoteJid: chatId,
          fromMe: true,
          id: targetMessageId,
          ...(targetParticipantJid ? { participant: targetParticipantJid } : {}),
        },
        text: reaction,
        senderTimestampMs: timestamp * 1_000,
      },
    },
  }));
}

/**
 * @param {WhatsAppTransportTestbedOptions} [options]
 * @returns {Promise<{
 *   transport: ChatTransport,
 *   sentMessages: SentWhatsAppMessage[],
 *   turns: ChannelInput[],
 *   processEvents: (events: BaileysEvents) => Promise<void>,
 *   start: (handler: (turn: ChannelInput) => Promise<void>) => Promise<void>,
 *   stop: () => Promise<void>,
 *   replayInboundCapture: (payload: import("@whiskeysockets/baileys").BaileysEventMap["messages.upsert"]) => Promise<void>,
 * }>}
 */
export async function createWhatsAppTransportTestbed(options = {}) {
  const botPhoneJid = options.botPhoneJid ?? "bot-phone-id:0@s.whatsapp.net";
  const botLidJid = options.botLidJid;
  /** @type {BaileysEventHandler | null} */
  let eventHandler = null;
  /** @type {SentWhatsAppMessage[]} */
  const sentMessages = [];
  /** @type {ChannelInput[]} */
  const turns = [];
  /** @type {Array<() => Promise<void>>} */
  const cleanups = [];

  /** @type {WhatsAppTransportSocketPort} */
  const socket = {
    user: {
      id: botPhoneJid,
      ...(botLidJid ? { lid: botLidJid.replace("@lid", ":32@lid") } : { lid: "bot-lid-id:0@lid" }),
      name: "VerticalTestBot",
    },
    ev: {
      process(handler) {
        eventHandler = async (events) => {
          await handler(events);
        };
      },
    },
    sendMessage: async (chatId, message) => {
      const id = `sent-${sentMessages.length + 1}`;
      sentMessages.push({ id, chatId, message });
      return { key: { id, remoteJid: chatId, fromMe: true } };
    },
    sendPresenceUpdate: async () => {},
    signalRepository: {
      lidMapping: {
        getPNForLID: async () => null,
      },
    },
    groupMetadata: async () => ({ participants: [] }),
  };

  let stopped = false;
  const transport = await createWhatsAppTransport({
    inboundCoalesceDelayMs: options.inboundCoalesceDelayMs ?? 5,
    ...(options.store ? { outboundStore: options.store } : {}),
    createConnectionSupervisor: async ({ onSocketReady }) => ({
      start: async () => {
        stopped = false;
        onSocketReady(socket, async () => {});
      },
      stop: async () => {
        stopped = true;
      },
      sendText: async () => {},
      handleConnectionUpdate: async () => {},
      isStopped: () => stopped,
    }),
  });

  /**
   * @param {BaileysEvents} events
   * @returns {Promise<void>}
   */
  async function processEvents(events) {
    if (!eventHandler) {
      throw new Error("Expected WhatsApp transport to register an event processor.");
    }
    await eventHandler(events);
  }

  /**
   * @param {(turn: ChannelInput) => Promise<void>} handler
   * @returns {Promise<void>}
   */
  async function start(handler) {
    await transport.start(async (turn) => {
      turns.push(turn);
      await handler(turn);
    });
    await processEvents({ "connection.update": { connection: "open" } });
  }

  /**
   * @returns {Promise<void>}
   */
  async function stop() {
    try {
      await transport.stop();
    } finally {
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    }
  }

  return {
    transport,
    sentMessages,
    turns,
    processEvents,
    start,
    stop,
    replayInboundCapture: async (payload) => {
      const capture = await writeWhatsAppInboundCapture({ event: "messages.upsert", payload });
      cleanups.push(async () => {
        await fs.rm(capture.tempDir, { recursive: true, force: true });
      });
      await replayWhatsAppCapture(capture.filePath, processEvents);
    },
  };
}

/**
 * @param {{
 *   event: "messages.upsert" | "messages.update",
 *   payload: unknown,
 *   capturedAt?: Date,
 * }} input
 * @returns {Promise<{ filePath: string, tempDir: string }>}
 */
async function writeWhatsAppInboundCapture(input) {
  const capturedAt = input.capturedAt ?? new Date("2026-06-21T09:00:10.000Z");
  const enabledUntil = new Date(capturedAt.getTime() + 5 * 60_000).toISOString();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-inbound-capture-"));
  const baseDir = path.join(tempDir, "capture");
  const diagnostics = createRuntimeDiagnosticsState({
    configPath: path.join(tempDir, "logging.json"),
    env: {},
    reloadIntervalMs: 0,
  });
  await diagnostics.update({
    capture: {
      seams: {
        "whatsapp.inbound": {
          enabledUntil,
          fullRawUntil: enabledUntil,
          rotateMinutes: 1,
          retentionHours: 24,
          queueLimit: 10,
        },
      },
    },
  });
  const fixtureCapture = createFixtureCapture({
    diagnosticsState: diagnostics,
    baseDir,
    now: () => capturedAt,
  });

  if (input.event === "messages.upsert") {
    captureWhatsAppUpsertEvent(input.payload, { fixtureCapture });
  } else {
    captureWhatsAppMessageUpdateEvent(/** @type {unknown[]} */ (input.payload), { fixtureCapture });
  }

  await fixtureCapture.waitForIdle();
  const filePath = await findSingleCaptureFile(baseDir);
  return { filePath, tempDir };
}

/**
 * @param {string} filePath
 * @param {(events: BaileysEvents) => Promise<void>} processEvents
 * @returns {Promise<void>}
 */
async function replayWhatsAppCapture(filePath, processEvents) {
  const records = await readNdjson(filePath);
  let replayed = 0;

  for (const record of records) {
    if (record.recordType !== "fixtureCapture.event") {
      continue;
    }
    if (record.seam === "whatsapp.inbound" && record.event === "messages.upsert") {
      await processEvents({
        "messages.upsert": /** @type {import("@whiskeysockets/baileys").BaileysEventMap["messages.upsert"]} */ (record.payload),
      });
      replayed += 1;
      continue;
    }
    if (record.seam === "whatsapp.inbound" && record.event === "messages.update") {
      await processEvents({
        "messages.update": /** @type {import("@whiskeysockets/baileys").BaileysEventMap["messages.update"]} */ (record.payload),
      });
      replayed += 1;
      continue;
    }
    throw new Error(`Unsupported capture event ${String(record.seam)}:${String(record.event)}.`);
  }

  if (replayed === 0) {
    throw new Error(`Expected at least one fixtureCapture.event in ${filePath}.`);
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function readNdjson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)));
}

/**
 * @param {string} baseDir
 * @returns {Promise<string>}
 */
async function findSingleCaptureFile(baseDir) {
  const entries = await fs.readdir(baseDir);
  const files = entries.filter((entry) => entry.endsWith(".ndjson"));
  if (files.length !== 1) {
    throw new Error(`Expected one capture file in ${baseDir}, got ${files.length}.`);
  }
  return path.join(baseDir, files[0]);
}
