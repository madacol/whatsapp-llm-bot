import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deliverPendingRestartAck } from "../actions/admin/restart/_restart-ack-delivery.js";
import { createRestartAckStore } from "../actions/admin/restart/_restart-ack-store.js";

describe("restart acknowledgement delivery", () => {
  it("edits the persisted restart acknowledgement message after startup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ transportHandleId: string, text: string }>} */
    const edits = [];
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "chat-1@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        transportHandleId: "whatsapp-handle-1",
      });

      await deliverPendingRestartAck({
        store,
        editMessage: async (input) => {
          edits.push(input);
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      });

      assert.deepEqual(edits, [{
        transportHandleId: "whatsapp-handle-1",
        text: "Restarted.",
      }]);
      assert.deepEqual(sent, []);
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not send a duplicate restarted message when the persisted marker has no editable handle", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ transportHandleId: string, text: string }>} */
    const edits = [];
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "chat-2@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
      });

      await deliverPendingRestartAck({
        store,
        editMessage: async (input) => {
          edits.push(input);
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      });

      assert.deepEqual(edits, []);
      assert.deepEqual(sent, []);
      const persisted = await store.read();
      assert.equal(persisted?.chatId, "chat-2@g.us");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not send a duplicate restarted message when the persisted edit handle is gone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "chat-lost-handle@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        transportHandleId: "wa-edit-missing",
      });

      await deliverPendingRestartAck({
        store,
        editMessage: async ({ transportHandleId }) => {
          throw new Error(`WhatsApp edit handle ${transportHandleId} was not found.`);
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      });

      assert.deepEqual(sent, []);
      const persisted = await store.read();
      assert.equal(persisted?.transportHandleId, "wa-edit-missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports active turns that were force-interrupted by restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ transportHandleId: string, text: string }>} */
    const edits = [];
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "restart-chat@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        transportHandleId: "restart-handle-1",
        interruptedTurns: [{
          chatId: "active-chat@g.us",
          label: "codex",
        }],
      });

      await deliverPendingRestartAck({
        store,
        editMessage: async (input) => {
          edits.push(input);
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      });

      assert.deepEqual(edits, [{
        transportHandleId: "restart-handle-1",
        text: "Restarted.",
      }]);
      assert.deepEqual(sent, [{
        chatId: "active-chat@g.us",
        text: "Previous codex turn was interrupted by restart before it completed. No final result was produced.",
      }]);
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers the message key from a flushed queue row before editing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ transportHandleId: string, text: string }>} */
    const edits = [];
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "chat-queued@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        queueId: 44,
      });

      await deliverPendingRestartAck({
        store,
        editMessage: async (input) => {
          edits.push(input);
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        recoverQueuedMessage: ({ chatId, queueId }) => {
          assert.equal(chatId, "chat-queued@g.us");
          assert.equal(queueId, 44);
          return {
            transportHandleId: "recovered-transport-handle",
            deliveryStatus: "sent",
            waitUntilSent: async function () {
              return this;
            },
            update: async () => {},
            setInspect: () => {},
          };
        },
      });

      assert.deepEqual(edits, [{
        text: "Restarted.",
        transportHandleId: "recovered-transport-handle",
      }]);
      assert.deepEqual(sent, []);
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the marker when a queued acknowledgement has not flushed yet", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "chat-pending@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        queueId: 45,
      });

      await deliverPendingRestartAck({
        store,
        editMessage: async () => {
          throw new Error("edit should not run without a key");
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        recoverQueuedMessage: () => undefined,
      });

      assert.deepEqual(sent, []);
      const persisted = await store.read();
      assert.equal(persisted?.queueId, 45);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the marker in place when post-startup delivery fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);

    try {
      await store.save({
        chatId: "chat-3@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        transportHandleId: "failed-handle-3",
      });

      await assert.rejects(
        () => deliverPendingRestartAck({
          store,
          editMessage: async () => {
            throw new Error("Connection Closed");
          },
          sendText: async () => {},
        }),
        /Connection Closed/,
      );

      const persisted = JSON.parse(await readFile(storePath, "utf8"));
      assert.equal(persisted.transportHandleId, "failed-handle-3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
