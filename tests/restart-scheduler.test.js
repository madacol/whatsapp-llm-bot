import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scheduleRestart } from "../restart/restart-scheduler.js";

/**
 * @typedef {{ level: "info" | "error", message: string, data: Record<string, unknown> }} TestLogEntry
 */

function createLogSink() {
  /** @type {TestLogEntry[]} */
  const entries = [];
  return {
    entries,
    log: {
      /** @param {string} message @param {Record<string, unknown>} [data] */
      info: (message, data) => entries.push({ level: "info", message, data: data ?? {} }),
      /** @param {string} message @param {Record<string, unknown>} [data] */
      error: (message, data) => entries.push({ level: "error", message, data: data ?? {} }),
    },
  };
}

describe("restart scheduler observability", () => {
  it("logs the scheduled restart and the SIGTERM delivery with the restart id", () => {
    /** @type {{ callback: (() => void) | null }} */
    const scheduled = { callback: null };
    /** @type {Array<{ pid: number, signal: NodeJS.Signals }>} */
    const killed = [];
    const { entries, log } = createLogSink();

    scheduleRestart({
      restartId: "restart-scheduler-1",
      pid: 1234,
      delayMs: 5,
      log,
      setTimeoutFn: (callback, delayMs) => {
        assert.equal(delayMs, 5);
        scheduled.callback = callback;
        return { unref: () => {} };
      },
      killFn: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });

    const scheduledCallback = scheduled.callback;
    if (typeof scheduledCallback !== "function") {
      assert.fail("expected restart callback to be scheduled");
    }
    scheduledCallback();

    assert.deepEqual(killed, [{ pid: 1234, signal: "SIGTERM" }]);
    assert.deepEqual(entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      restartId: entry.data.restartId,
      pid: entry.data.pid,
    })), [
      {
        level: "info",
        message: "Restart signal scheduled.",
        restartId: "restart-scheduler-1",
        pid: 1234,
      },
      {
        level: "info",
        message: "Restart SIGTERM sending.",
        restartId: "restart-scheduler-1",
        pid: 1234,
      },
      {
        level: "info",
        message: "Restart SIGTERM sent.",
        restartId: "restart-scheduler-1",
        pid: 1234,
      },
    ]);
  });
});
