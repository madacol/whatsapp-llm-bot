import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRestartCommandHandler } from "../commands/restart-command.js";
import { createRestartAckStore } from "../restart/restart-ack-store.js";
import config from "../config.js";

function createLogSink() {
  /** @type {Array<{ level: string, message: string, data: Record<string, unknown> }>} */
  const entries = [];
  return {
    entries,
    log: {
      info: (message, data) => entries.push({ level: "info", message, data: data ?? {} }),
      warn: (message, data) => entries.push({ level: "warn", message, data: data ?? {} }),
      error: (message, data) => entries.push({ level: "error", message, data: data ?? {} }),
    },
  };
}

describe("restart command observability", () => {
  it("schedules restart immediately while active sidecar turns keep running", async () => {
    const originalMasterIds = config.MASTER_IDs;
    config.MASTER_IDs = ["master-user"];
    const savedRecords = [];
    const { entries, log } = createLogSink();
    /** @type {Array<{ restartId?: string } | undefined>} */
    const scheduled = [];
    try {
      const restartAckStore = createRestartAckStore();
      restartAckStore.save = async (record) => {
        savedRecords.push(record);
      };
      const handler = createRestartCommandHandler({
        createRestartId: () => "restart-test-1",
        restartScheduler: (input) => {
          scheduled.push(input);
        },
        restartAckStore,
        restartRuntime: {
          listActiveTurns: () => [{
            chatId: "active-chat@g.us",
            label: "Codex",
            activeTurnId: "turn-active-1",
            resumeCursor: "session-active-1",
            status: "running",
          }],
        },
        log,
      });
      const result = await handler({ chatId: "restart-chat@g.us", senderIds: ["master-user"] }, {});
      await result.afterResponse({
        handle: {
          queueId: 42,
          update: async () => {},
          setInspect: () => {},
          waitUntilSent: async () => ({ transportHandleId: "transport-restart-1" }),
        },
      });

      assert.deepEqual(scheduled, [{ restartId: "restart-test-1" }]);
      assert.deepEqual(savedRecords.map((record) => ({
        restartId: record.restartId,
        chatId: record.chatId,
        queueId: record.queueId,
        transportHandleId: record.transportHandleId ?? null,
        interruptedTurns: record.interruptedTurns ?? null,
      })), [
        {
          restartId: "restart-test-1",
          chatId: "restart-chat@g.us",
          queueId: 42,
          transportHandleId: null,
          interruptedTurns: null,
        },
        {
          restartId: "restart-test-1",
          chatId: "restart-chat@g.us",
          queueId: 42,
          transportHandleId: "transport-restart-1",
          interruptedTurns: null,
        },
      ]);
      assert.deepEqual(entries.map((entry) => entry.message), [
        "Restart command accepted.",
        "Restart ack marker saved.",
        "Restart ack marker attached to sent transport handle.",
        "Restart scheduler invoked.",
      ]);
      assert.ok(entries.every((entry) => entry.data?.restartId === "restart-test-1"));
      assert.deepEqual(entries[0]?.data.activeTurns, [{
        chatId: "active-chat@g.us",
        label: "Codex",
        activeTurnId: "turn-active-1",
        resumeCursor: "session-active-1",
        status: "running",
      }]);
    } finally {
      config.MASTER_IDs = originalMasterIds;
    }
  });

  it("ignores legacy force parameters instead of recording interrupted turns", async () => {
    const originalMasterIds = config.MASTER_IDs;
    config.MASTER_IDs = ["master-user"];
    const savedRecords = [];
    try {
      const restartAckStore = createRestartAckStore();
      restartAckStore.save = async (record) => {
        savedRecords.push(record);
      };
      const handler = createRestartCommandHandler({
        createRestartId: () => "restart-test-force-removed",
        restartScheduler: () => {},
        restartAckStore,
        restartRuntime: {
          listActiveTurns: () => [{
            chatId: "active-chat@g.us",
            label: "Codex",
            activeTurnId: "turn-active-1",
            resumeCursor: "session-active-1",
            status: "running",
          }],
        },
      });

      const result = await handler(
        { chatId: "restart-chat@g.us", senderIds: ["master-user"] },
        { mode: "force" },
      );
      await result.afterResponse();

      assert.equal(savedRecords.length, 1);
      assert.equal(savedRecords[0]?.interruptedTurns, undefined);
    } finally {
      config.MASTER_IDs = originalMasterIds;
    }
  });
});
