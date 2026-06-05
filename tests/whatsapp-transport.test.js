import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWhatsAppTransport,
  executeCommunityCreate,
  executeCommunityCreateGroup,
  executeGroupLinkedParentLookup,
  executeGroupParticipantLookup,
} from "../whatsapp/create-whatsapp-transport.js";
import { setDb } from "../db.js";
import { initStore } from "../store.js";
import { createTestDb, createWAMessage } from "./helpers.js";
import { contentEvent, textUpdate } from "../outbound-events.js";
import { createRestartCommandHandler } from "../commands/restart-command.js";
import { createRestartAckStore } from "../restart/restart-ack-store.js";
import { deliverPendingRestartAck } from "../restart/restart-ack-delivery.js";
import { sendOrQueueWhatsAppEvent } from "../whatsapp/outbound/persistent-queue.js";
import { makeTextMessage } from "../whatsapp/message-payloads.js";

/** @type {import("@electric-sql/pglite").PGlite | null} */
let testDb = null;
/** @type {import("../store.js").Store | null} */
let testStore = null;
const originalOutboundQueuePersistDelayMs = process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;

before(async () => {
  process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = "0";
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  testStore = await initStore(testDb);
});

after(() => {
  if (originalOutboundQueuePersistDelayMs === undefined) {
    delete process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
  } else {
    process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = originalOutboundQueuePersistDelayMs;
  }
});

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} chatId
 * @returns {Promise<Array<{ id: number, chat_id: string, payload_json: unknown }>>}
 */
async function getQueuedRows(db, chatId) {
  const { rows } = await db.sql`
    SELECT id, chat_id, payload_json
    FROM whatsapp_outbound_queue
    WHERE chat_id = ${chatId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    chat_id: String(row.chat_id),
    payload_json: row.payload_json,
  }));
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} chatId
 * @returns {Promise<Array<{ original_queue_id: number, chat_id: string, reason: string }>>}
 */
async function getDeadLetterRows(db, chatId) {
  const { rows } = await db.sql`
    SELECT original_queue_id, chat_id, reason
    FROM whatsapp_outbound_dead_letter
    WHERE chat_id = ${chatId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    original_queue_id: Number(row.original_queue_id),
    chat_id: String(row.chat_id),
    reason: String(row.reason),
  }));
}

function createBaileysGroupMetadataAttrsError() {
  const error = new TypeError("Cannot read properties of undefined (reading 'attrs')");
  error.stack = [
    `${error.name}: ${error.message}`,
    "    at extractGroupMetadata (node_modules/@whiskeysockets/baileys/lib/Socket/groups.js:286:27)",
    "    at groupMetadata (node_modules/@whiskeysockets/baileys/lib/Socket/groups.js:20:16)",
    "    at async node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js:479:41",
  ].join("\n");
  return error;
}

async function waitForTransportBackgroundWork() {
  for (let i = 0; i < 5; i += 1) {
    await delay(0);
  }
}

describe("WhatsApp transport community creation", () => {
  it("buffers streamed LLM chunks in WhatsApp until completion", async () => {
    const chatId = `stream-buffer-${Date.now()}`;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));
    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: contentEvent("llm", [{ type: "markdown", text: "Hel" }], {
        stream: { id: "assistant-1", status: "partial" },
      }),
    });
    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: contentEvent("llm", [{ type: "markdown", text: "lo" }], {
        stream: { id: "assistant-1", status: "partial" },
      }),
    });
    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: contentEvent("llm", [{ type: "markdown", text: " wor" }], {
        stream: { id: "assistant-1", status: "partial" },
      }),
    });
    assert.deepEqual(sentMessages, []);

    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: contentEvent("llm", [{ type: "markdown", text: "Hello world" }], {
        stream: { id: "assistant-1", status: "final" },
      }),
    });
    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 Hello world"),
    }]);
  });

  it("coalesces rapid same-chat turn messages before invoking the app handler", async () => {
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {ChatTurn[]} */
    const turns = [];
    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendPresenceUpdate: async () => {},
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
    });

    await transport.start(async (turn) => {
      turns.push(turn);
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ text: "first", senderId: "rapid-user" }),
          createWAMessage({ text: "second", senderId: "rapid-user" }),
        ],
      },
    });
    await delay(25);

    assert.equal(turns.length, 1);
    assert.deepEqual(
      turns[0].content.filter((block) => block.type === "text").map((block) => block.text),
      ["first", "second"],
    );
  });

  it("replays queued outbound events when the connection opens again", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-transport-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection Closed");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    const queuedHandle = await transport.sendEvent?.(chatId, {
      kind: "content",
      source: "llm",
      content: "queued on disconnect",
    });

    assert.equal(queuedHandle?.deliveryStatus, "queued");
    assert.equal(typeof queuedHandle?.waitUntilSent, "function");
    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued on disconnect"),
    }]);
    const sentHandle = await queuedHandle?.waitUntilSent?.({ timeoutMs: 10 });
    assert.equal(sentHandle?.deliveryStatus, "sent");
    assert.equal(typeof sentHandle?.transportHandleId, "string");
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("applies queued handle updates to the sent message after reconnect", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-update-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection Closed");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    const queuedHandle = await transport.sendEvent?.(chatId, contentEvent("llm", "queued before edit"));
    assert.equal(queuedHandle?.deliveryStatus, "queued");

    const updatePromise = queuedHandle?.update(textUpdate("queued after edit"));

    failSends = false;
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await updatePromise;

    assert.deepEqual(sentMessages, [
      {
        chatId,
        message: makeTextMessage("🤖 queued before edit"),
      },
      {
        chatId,
        message: makeTextMessage("🤖 queued after edit", {
          edit: { id: "sent-1", remoteJid: chatId, fromMe: true },
        }),
      },
    ]);
  });

  it("queues outbound events after websocket abnormal closure send failures", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-1006-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("1006");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });

    await transport.sendEvent?.(chatId, {
      kind: "content",
      source: "llm",
      content: "queued after 1006",
    });

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued after 1006"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("delays durable queue writes and retries if the socket recovers during the debounce window", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const previousDelay = process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
    process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = "30";
    try {
      const chatId = `debounced-queue-${Date.now()}`;
      /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
      const sentMessages = [];
      let liveSocket = /** @type {import("@whiskeysockets/baileys").WASocket | null} */ (null);
      const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
        sendMessage: async (targetChatId, message) => {
          sentMessages.push({ chatId: targetChatId, message });
          return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
        },
      }));

      const sendPromise = sendOrQueueWhatsAppEvent({
        getSocket: () => liveSocket,
        chatId,
        event: contentEvent("llm", "send after quick reconnect"),
        store: testStore,
      });

      assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
      liveSocket = socket;
      const handle = await sendPromise;

      assert.equal(handle?.deliveryStatus, "sent");
      assert.deepEqual(sentMessages, [{
        chatId,
        message: makeTextMessage("🤖 send after quick reconnect"),
      }]);
      assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
      } else {
        process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = previousDelay;
      }
    }
  });

  it("keeps queued outbound rows when the connection is lost during reconnect", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-group-metadata-${Date.now()}@g.us`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection was lost");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    await transport.sendEvent?.(chatId, contentEvent("llm", "queued during reconnect"));
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued during reconnect"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("quarantines row-specific replay failures without blocking later FIFO rows", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `quarantine-${Date.now()}@g.us`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failMetadataRow = true;

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: contentEvent("llm", "old blocked answer"),
      },
    });
    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: contentEvent("tool-result", "Restart signal sent."),
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (message.text === "🤖 old blocked answer" && failMetadataRow) {
          failMetadataRow = false;
          throw createBaileysGroupMetadataAttrsError();
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("✅ Restart signal sent."),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    const deadLetters = await getDeadLetterRows(testDb, chatId);
    assert.equal(deadLetters.length, 1);
    assert.match(deadLetters[0].reason, /attrs/);
  });

  it("replays queued runtime events instead of treating them as malformed", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `runtime-replay-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: {
          kind: "runtime_event",
          event: {
            type: "turn.started",
            provider: "codex",
            turn: { status: "started" },
          },
        },
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();
    for (let attempt = 0; sentMessages.length < 2 && attempt < 50; attempt += 1) {
      await delay(10);
    }

    assert.deepEqual(sentMessages, [
      {
        chatId,
        message: makeTextMessage("🔄 *CODEX*  turn started"),
      },
      {
        chatId,
        message: {
          pin: { id: "sent-1", remoteJid: chatId, fromMe: true },
          type: 1,
          time: 86400,
        },
      },
    ]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    assert.equal((await getDeadLetterRows(testDb, chatId)).length, 0);
  });

  it("runs connection-open hooks after queued outbound messages are flushed", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `restart-open-hook-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {string[]} */
    const hookObservations = [];
    /** @type {number | undefined} */
    let queuedAckId;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      onConnectionOpen: async ({ editMessage, recoverQueuedMessage, phase }) => {
        if (phase !== "afterQueueFlush") {
          return;
        }
        hookObservations.push(`sent:${sentMessages.length}`);
        if (!queuedAckId) {
          throw new Error("Expected queued handle id before connection open");
        }
        const recoveredHandle = recoverQueuedMessage({ chatId, queueId: queuedAckId });
        assert.equal(typeof recoveredHandle?.transportHandleId, "string");
        await editMessage({
          transportHandleId: recoveredHandle.transportHandleId,
          text: "Restarted.",
        });
      },
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    const queuedHandle = await transport.sendEvent?.(chatId, {
      kind: "content",
      source: "llm",
      content: "queued before open hook",
    });
    queuedAckId = queuedHandle?.queueId;

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookObservations, ["sent:1"]);
    assert.deepEqual(sentMessages, [
      {
        chatId,
        message: makeTextMessage("🤖 queued before open hook"),
      },
      {
        chatId,
        message: makeTextMessage("Restarted.", {
          edit: { id: "sent-1", remoteJid: chatId, fromMe: true },
        }),
      },
    ]);
  });

  it("runs connection-open hooks after queued outbound flushes complete", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `restart-open-hook-fifo-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {string[]} */
    const hookPhases = [];
    /** @type {() => void} */
    let releaseQueuedSend = () => {};
    const queuedSendWait = new Promise((resolve) => {
      releaseQueuedSend = () => resolve(undefined);
    });

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: contentEvent("llm", "queued unrelated output"),
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (message.text === "🤖 queued unrelated output") {
          await queuedSendWait;
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      onConnectionOpen: async ({ phase }) => {
        hookPhases.push(phase);
      },
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    let openResolved = false;
    const openPromise = processEvents({
      "connection.update": {
        connection: "open",
      },
    }).then(() => {
      openResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(openResolved, true);
    assert.deepEqual(hookPhases, []);
    assert.deepEqual(sentMessages, []);

    releaseQueuedSend();
    await openPromise;
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookPhases, ["afterQueueFlush"]);
    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued unrelated output"),
    }]);
  });

  it("waits for Baileys initial-sync buffering to drain before queued outbound replay", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `restart-open-buffering-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {string[]} */
    const hookPhases = [];
    let buffering = true;

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: contentEvent("llm", "queued while initial sync is buffering"),
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
        isBuffering() {
          return buffering;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      onConnectionOpen: async ({ phase }) => {
        hookPhases.push(phase);
      },
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, []);
    assert.deepEqual(hookPhases, []);

    buffering = false;
    await delay(150);
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookPhases, ["afterQueueFlush"]);
    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued while initial sync is buffering"),
    }]);
  });

  it("edits the restart acknowledgement through a transport-owned durable handle", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-transport-"));
    const restartAckStore = createRestartAckStore(path.join(dir, "ack.json"));
    const chatId = `restart-e2e-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    try {
      const firstTransport = await createWhatsAppTransport({
        createConnectionSupervisor: async ({ onSocketReady }) => ({
          start: async () => {
            onSocketReady(socket, async () => {});
          },
          stop: async () => {},
          sendText: async () => {},
          handleConnectionUpdate: async () => {},
          isStopped: () => false,
        }),
        outboundStore: testStore,
      });

      await firstTransport.start(async () => {});
      if (!processEvents) {
        throw new Error("Expected connection event processor to be registered");
      }
      await processEvents({ "connection.update": { connection: "open" } });

      const restartingHandle = await firstTransport.sendEvent?.(
        chatId,
        contentEvent("llm", "Restarting..."),
      );
      assert.equal(typeof restartingHandle?.transportHandleId, "string");

      let scheduled = 0;
      const restartCommandHandler = createRestartCommandHandler({
        restartScheduler: () => {
          scheduled += 1;
        },
        restartAckStore,
        restartRuntime: {
          listActiveTurns: () => [],
          waitForIdle: async () => [],
        },
      });
      const result = await restartCommandHandler({
        chatId,
        senderIds: ["master-user"],
      }, {});

      await result.afterResponse?.({ handle: restartingHandle });
      assert.equal(scheduled, 1);

      const pendingAck = await restartAckStore.read();
      assert.equal(typeof pendingAck?.transportHandleId, "string");
      assert.ok(await testStore.getWhatsAppEditHandle(pendingAck.transportHandleId));

      const secondTransport = await createWhatsAppTransport({
        createConnectionSupervisor: async ({ onSocketReady }) => ({
          start: async () => {
            onSocketReady(socket, async () => {});
          },
          stop: async () => {},
          sendText: async () => {},
          handleConnectionUpdate: async () => {},
          isStopped: () => false,
        }),
        onConnectionOpen: async ({ editMessage, sendText, recoverQueuedMessage }) => {
          await deliverPendingRestartAck({
            store: restartAckStore,
            editMessage,
            sendText,
            recoverQueuedMessage,
          });
        },
        outboundStore: testStore,
      });

      processEvents = null;
      await secondTransport.start(async () => {});
      if (!processEvents) {
        throw new Error("Expected second connection event processor to be registered");
      }
      await processEvents({ "connection.update": { connection: "open" } });
      await waitForTransportBackgroundWork();

      assert.deepEqual(sentMessages, [
        {
          chatId,
          message: makeTextMessage("🤖 Restarting..."),
        },
        {
          chatId,
          message: makeTextMessage("Restarted.", {
            edit: { id: "sent-1", remoteJid: chatId, fromMe: true },
          }),
        },
      ]);
      assert.equal(await restartAckStore.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queues turn replies while the socket exists but the connection is not open yet", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-before-open-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {() => void} */
    let resolveReplyHandled = () => {};
    const replyHandled = new Promise((resolve) => {
      resolveReplyHandled = resolve;
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
      sendPresenceUpdate: async () => {},
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async (turn) => {
      try {
        await turn.io.reply(contentEvent("llm", "queued while opening"));
      } finally {
        resolveReplyHandled();
      }
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({
            text: "reply before open",
            senderId: "early-user",
            chatId,
          }),
        ],
      },
    });
    await replyHandled;

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued while opening"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("returns the created community id from Baileys community metadata", async () => {
    const socket = {
      communityCreate: async () => ({
        id: "community-12345",
        subject: "Project Main",
      }),
    };

    const result = await executeCommunityCreate(socket, "Project Main", "Primary workspace community");

    assert.deepEqual(result, {
      chatId: "community-12345@g.us",
      subject: "Project Main",
    });
  });

  it("throws when Baileys communityCreate returns no community id", async () => {
    const socket = {
      communityCreate: async () => ({ subject: "Project Main" }),
    };

    await assert.rejects(
      () => executeCommunityCreate(socket, "Project Main", "Primary workspace community"),
      /Baileys communityCreate returned no community id\./,
    );
  });

  it("returns the created subgroup id from Baileys group metadata", async () => {
    const socket = {
      communityCreateGroup: async () => ({
        id: "group-12345",
        subject: "payments",
      }),
    };

    const result = await executeCommunityCreateGroup(
      socket,
      "payments",
      ["user@s.whatsapp.net"],
      "community-12345@g.us",
    );

    assert.deepEqual(result, {
      chatId: "group-12345@g.us",
      subject: "payments",
    });
  });

  it("throws when Baileys communityCreateGroup returns no group id", async () => {
    const socket = {
      communityCreateGroup: async () => ({ subject: "payments" }),
    };

    await assert.rejects(
      () => executeCommunityCreateGroup(
        socket,
        "payments",
        ["user@s.whatsapp.net"],
        "community-12345@g.us",
      ),
      /Baileys communityCreateGroup returned no group id\./,
    );
  });

  it("returns the linked parent from Baileys group metadata", async () => {
    const socket = {
      groupMetadata: async () => ({
        linkedParent: "community-12345",
      }),
    };

    const result = await executeGroupLinkedParentLookup(socket, "group-12345@g.us");

    assert.equal(result, "community-12345@g.us");
  });

  it("returns null when Baileys group metadata has no linked parent", async () => {
    const socket = {
      groupMetadata: async () => ({
        linkedParent: null,
      }),
    };

    const result = await executeGroupLinkedParentLookup(socket, "group-12345@g.us");

    assert.equal(result, null);
  });

  it("returns deduped participant ids from Baileys group metadata", async () => {
    const socket = {
      groupMetadata: async () => ({
        participants: [
          { id: "user@s.whatsapp.net" },
          { id: "teammate@s.whatsapp.net" },
          { id: "user@s.whatsapp.net" },
          { id: "" },
          {},
        ],
      }),
    };

    const result = await executeGroupParticipantLookup(socket, "group-12345@g.us");

    assert.deepEqual(result, [
      "user@s.whatsapp.net",
      "teammate@s.whatsapp.net",
    ]);
  });
});
