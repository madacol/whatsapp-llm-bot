import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { updateChatConfig } from "../chat-config.js";
import { initStore } from "../store.js";
import { createTestDb, seedChat } from "./helpers.js";
import { createWhatsAppOutboundDurability } from "../whatsapp/outbound/durability.js";

describe("WhatsApp outbound durability", () => {
  it("owns live fallback, replay, output visibility, and queued handle resolution behind one seam", async () => {
    const db = await createTestDb();
    const store = await initStore(db);
    await seedChat(db, "chat-1", { enabled: true });
    await updateChatConfig("chat-1", (current) => ({
      ...current,
      output_visibility: { thinking: false },
    }));

    /** @type {Array<{ chatId: string, payload: unknown }>} */
    const enqueued = [];
    /** @type {Array<{ chatId: string, event: OutboundEvent, outputVisibility: unknown }>} */
    const deliveredEvents = [];
    /** @type {Array<{ chatId: string, id: number }>} */
    const deleted = [];
    let socket = /** @type {import("@whiskeysockets/baileys").WASocket | null} */ (null);
    const sentHandle = {
      deliveryStatus: /** @type {const} */ ("sent"),
      update: async () => {},
      setInspect: () => {},
    };

    const durability = createWhatsAppOutboundDurability({
      getSocket: () => socket,
      store,
      persistDelayMs: 0,
      replayDelayMs: 0,
      sleep: async () => {},
      deliverEvent: async (_sock, chatId, event, _options, _reactionRuntime, sendOptions) => {
        deliveredEvents.push({ chatId, event, outputVisibility: sendOptions?.outputVisibility });
        return sentHandle;
      },
      enqueueOutbound: async (chatId, payload) => {
        enqueued.push({ chatId, payload });
        return { id: 41, chat_id: chatId, payload_json: payload };
      },
      listQueuedOutbound: async () => [
        {
          id: 41,
          chatId: "chat-1",
          payload: /** @type {import("../whatsapp/outbound/queue-store.js").WhatsAppOutboundQueuePayload} */ ({
            kind: "event",
            event: {
              kind: "runtime_event",
              event: {
                type: "turn.started",
                provider: "codex",
                turn: { id: "turn-1", chatId: "chat-1", status: "started" },
              },
            },
          }),
        },
      ],
      deleteQueuedOutbound: async (chatId, id) => {
        deleted.push({ chatId, id });
      },
    });

    const handle = await durability.sendOrQueueEvent({
      chatId: "chat-1",
      event: {
        kind: "runtime_event",
        event: {
          type: "turn.started",
          provider: "codex",
          turn: { id: "turn-1", chatId: "chat-1", status: "started" },
        },
      },
    });

    assert.equal(handle?.deliveryStatus, "queued");
    assert.deepEqual(enqueued.map((entry) => entry.chatId), ["chat-1"]);
    assert.equal(deliveredEvents.length, 0);

    socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ ({});
    const deliveredRows = await durability.flushQueued();
    const resolvedHandle = await handle?.waitUntilSent?.({ timeoutMs: 10 });

    assert.deepEqual(deliveredRows, [{ chatId: "chat-1", queueId: 41, handle: sentHandle }]);
    assert.deepEqual(deleted, [{ chatId: "chat-1", id: 41 }]);
    assert.equal(deliveredEvents.length, 1);
    assert.equal(deliveredEvents[0]?.chatId, "chat-1");
    assert.equal(typeof deliveredEvents[0]?.outputVisibility, "object");
    assert.equal(resolvedHandle, sentHandle);
  });
});
