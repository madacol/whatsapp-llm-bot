import { before, describe, it } from "node:test";
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
import { createRestartAction } from "../actions/admin/restart/index.js";
import { createRestartAckStore } from "../actions/admin/restart/_restart-ack-store.js";
import { deliverPendingRestartAck } from "../actions/admin/restart/_restart-ack-delivery.js";

/** @type {import("@electric-sql/pglite").PGlite | null} */
let testDb = null;
/** @type {import("../store.js").Store | null} */
let testStore = null;

before(async () => {
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  testStore = await initStore(testDb);
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

describe("WhatsApp transport community creation", () => {
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

    assert.deepEqual(sentMessages, [{
      chatId,
      message: { text: "🤖 queued on disconnect" },
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
        message: { text: "🤖 queued before edit" },
      },
      {
        chatId,
        message: {
          text: "🤖 queued after edit",
          edit: { id: "sent-1", remoteJid: chatId },
        },
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

    assert.deepEqual(sentMessages, [{
      chatId,
      message: { text: "🤖 queued after 1006" },
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
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
      onConnectionOpen: async ({ editMessage, recoverQueuedMessage }) => {
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

    assert.deepEqual(hookObservations, ["sent:1"]);
    assert.deepEqual(sentMessages, [
      {
        chatId,
        message: { text: "🤖 queued before open hook" },
      },
      {
        chatId,
        message: {
          text: "Restarted.",
          edit: { id: "sent-1", remoteJid: chatId },
        },
      },
    ]);
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
      const restartAction = createRestartAction(
        () => {
          scheduled += 1;
        },
        restartAckStore,
        {
          listActiveTurns: () => [],
          waitForIdle: async () => [],
        },
      );
      const result = await restartAction.action_fn({
        chatId,
        senderIds: ["master-user"],
        content: [],
        getIsAdmin: async () => true,
        db: testDb,
        sessionDb: testDb,
        getActions: async () => [],
        log: async () => "",
        send: async () => {},
        reply: async () => {},
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
        resolveModel: () => "test-model",
      }, {});

      if (typeof result !== "object" || result === null || Array.isArray(result) || !("afterResponse" in result)) {
        throw new Error("Expected restart action to return an afterResponse hook");
      }
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

      assert.deepEqual(sentMessages, [
        {
          chatId,
          message: { text: "🤖 Restarting..." },
        },
        {
          chatId,
          message: {
            text: "Restarted.",
            edit: { id: "sent-1", remoteJid: chatId },
          },
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

    assert.deepEqual(sentMessages, [{
      chatId,
      message: { text: "🤖 queued while opening" },
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
