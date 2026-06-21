import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deliverPendingRestartAck } from "../restart/restart-ack-delivery.js";
import { createRestartAckStore } from "../restart/restart-ack-store.js";

function createLogSink() {
  /** @type {Array<{ level: string, message: string, data: Record<string, unknown> }>} */
  const entries = [];
  return {
    entries,
    log: {
      info: (message, data) => entries.push({ level: "info", message, data: data ?? {} }),
      warn: (message, data) => entries.push({ level: "warn", message, data: data ?? {} }),
    },
  };
}

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

  it("falls back to sending restarted when the persisted marker has no editable handle", async () => {
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
      assert.deepEqual(sent, [{
        chatId: "chat-2@g.us",
        text: "Restarted.",
      }]);
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defers queued-only restart acknowledgements before the outbound queue has flushed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "chat-queued-before-flush@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        queueId: 88,
      });

      await deliverPendingRestartAck({
        store,
        phase: "beforeQueueFlush",
        editMessage: async () => {
          throw new Error("edit should not be attempted before queue recovery");
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        recoverQueuedMessage: () => undefined,
      });

      assert.deepEqual(sent, []);
      assert.deepEqual(await store.read(), {
        chatId: "chat-queued-before-flush@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        queueId: 88,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to sending restarted when the persisted edit handle is gone", async () => {
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

      assert.deepEqual(sent, [{
        chatId: "chat-lost-handle@g.us",
        text: "Restarted.",
      }]);
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to sending restarted when the persisted edit handle expired", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    /** @type {Array<{ chatId: string, text: string }>} */
    const sent = [];

    try {
      await store.save({
        chatId: "chat-expired-handle@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        transportHandleId: "wa-edit-expired",
      });

      await deliverPendingRestartAck({
        store,
        editMessage: async ({ transportHandleId }) => {
          throw new Error(`WhatsApp edit handle ${transportHandleId} expired.`);
        },
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      });

      assert.deepEqual(sent, [{
        chatId: "chat-expired-handle@g.us",
        text: "Restarted.",
      }]);
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports interrupted turns from legacy restart acknowledgement records", async () => {
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

  it("logs post-start acknowledgement delivery with the persisted restart id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-ack-"));
    const storePath = path.join(dir, "ack.json");
    const store = createRestartAckStore(storePath);
    const { entries, log } = createLogSink();

    try {
      await store.save({
        restartId: "restart-delivery-1",
        chatId: "restart-chat@g.us",
        requestedAt: "2026-05-15T19:00:00.000Z",
        oldPid: 123,
        transportHandleId: "restart-handle-1",
      });

      await deliverPendingRestartAck({
        store,
        log,
        editMessage: async () => {},
        sendText: async () => {},
      });

      assert.deepEqual(entries.map((entry) => ({
        message: entry.message,
        restartId: entry.data.restartId,
        chatId: entry.data.chatId,
      })), [
        {
          message: "Pending restart acknowledgement found.",
          restartId: "restart-delivery-1",
          chatId: "restart-chat@g.us",
        },
        {
          message: "Restart acknowledgement edited.",
          restartId: "restart-delivery-1",
          chatId: "restart-chat@g.us",
        },
        {
          message: "Restart acknowledgement marker cleared.",
          restartId: "restart-delivery-1",
          chatId: "restart-chat@g.us",
        },
      ]);
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

  it("falls back to sending restarted when a queued acknowledgement cannot be recovered", async () => {
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

      assert.deepEqual(sent, [{
        chatId: "chat-pending@g.us",
        text: "Restarted.",
      }]);
      assert.equal(await store.read(), null);
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
