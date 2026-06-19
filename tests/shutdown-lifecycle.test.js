import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGracefulShutdownHandler } from "../shutdown-lifecycle.js";

function deferred() {
  /** @type {(value: unknown) => void} */
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve: /** @type {(value?: unknown) => void} */ (resolve) };
}

function createTimerHarness() {
  /** @type {{ ms: number, callback: () => void, cleared: boolean, unrefCalled: boolean }[]} */
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, ms) {
      const timer = { ms, callback, cleared: false, unrefCalled: false };
      timers.push(timer);
      return {
        unref() {
          timer.unrefCalled = true;
        },
        get _timer() {
          return timer;
        },
      };
    },
    clearTimeoutFn(handle) {
      handle._timer.cleared = true;
    },
  };
}

async function waitForTimer(timers, ms) {
  for (let index = 0; index < 10; index += 1) {
    const timer = timers.find((entry) => entry.ms === ms && !entry.cleared);
    if (timer) {
      return timer;
    }
    await Promise.resolve();
  }
  return undefined;
}

describe("graceful shutdown lifecycle", () => {
  it("does not apply the cleanup force-exit timer while active agent turns are draining", async () => {
    const activeDrain = deferred();
    const events = [];
    const timers = createTimerHarness();
    const shutdown = createGracefulShutdownHandler({
      forceCleanupTimeoutMs: 10_000,
      activeTurnTimeoutMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      exitFn: (code) => {
        events.push(`exit:${code}`);
      },
      log: {
        info: (message) => events.push(`info:${message}`),
        error: (message) => events.push(`error:${message}`),
      },
      waitForActiveTurns: async () => {
        events.push("active-wait-start");
        await activeDrain.promise;
        events.push("active-wait-done");
        return ["active-chat@g.us"];
      },
      cleanupResources: async () => {
        events.push("cleanup");
      },
    });

    const shutdownPromise = shutdown("SIGTERM");
    await Promise.resolve();

    for (const timer of timers.timers.filter((entry) => entry.ms === 10_000)) {
      timer.callback();
    }
    assert.deepEqual(events, ["info:SIGTERM received, waiting for active turns before cleanup...", "active-wait-start"]);

    activeDrain.resolve();
    await shutdownPromise;

    assert.deepEqual(events, [
      "info:SIGTERM received, waiting for active turns before cleanup...",
      "active-wait-start",
      "active-wait-done",
      "info:Shutdown waited on 1 chat(s): active-chat@g.us",
      "cleanup",
      "exit:0",
    ]);
  });

  it("force-exits if resource cleanup hangs after active agent turns drain", async () => {
    const cleanup = deferred();
    const events = [];
    const timers = createTimerHarness();
    const shutdown = createGracefulShutdownHandler({
      forceCleanupTimeoutMs: 10_000,
      activeTurnTimeoutMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      exitFn: (code) => {
        events.push(`exit:${code}`);
      },
      log: {
        info: (message) => events.push(`info:${message}`),
        error: (message) => events.push(`error:${message}`),
      },
      waitForActiveTurns: async () => [],
      cleanupResources: async () => {
        events.push("cleanup-start");
        await cleanup.promise;
      },
    });

    const shutdownPromise = shutdown("SIGTERM");

    const cleanupTimer = await waitForTimer(timers.timers, 10_000);
    assert.ok(cleanupTimer);
    cleanupTimer.callback();

    assert.deepEqual(events, [
      "info:SIGTERM received, waiting for active turns before cleanup...",
      "cleanup-start",
      "error:SIGTERM cleanup timed out after 10000ms; exiting anyway.",
      "exit:0",
    ]);

    cleanup.resolve();
    await shutdownPromise;
    assert.deepEqual(events, [
      "info:SIGTERM received, waiting for active turns before cleanup...",
      "cleanup-start",
      "error:SIGTERM cleanup timed out after 10000ms; exiting anyway.",
      "exit:0",
    ]);
  });
});
