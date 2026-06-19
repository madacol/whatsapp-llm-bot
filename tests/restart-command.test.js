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
  it("correlates restart command, ack marker, active-turn wait, and scheduler", async () => {
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
          beginWaiting: () => {},
          waitForIdle: async () => [{
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
      })), [
        {
          restartId: "restart-test-1",
          chatId: "restart-chat@g.us",
          queueId: 42,
          transportHandleId: null,
        },
        {
          restartId: "restart-test-1",
          chatId: "restart-chat@g.us",
          queueId: 42,
          transportHandleId: "transport-restart-1",
        },
      ]);
      assert.deepEqual(entries.map((entry) => entry.message), [
        "Restart command accepted.",
        "Restart waiting for active turns.",
        "Restart ack marker saved.",
        "Restart ack marker attached to sent transport handle.",
        "Restart active turn wait starting.",
        "Restart active turn wait completed.",
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
});
