import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStartupRecoveryCoordinator, waitForPidExit } from "../index.js";

describe("index restart process wait", () => {
  it("sleeps between liveness probes instead of busy-waiting", async () => {
    let now = 0;
    let probes = 0;
    /** @type {number[]} */
    const sleeps = [];

    const exited = await waitForPidExit(1234, {
      timeoutMs: 1_000,
      pollIntervalMs: 250,
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      killFn: () => {
        probes += 1;
        if (probes >= 3) {
          throw new Error("process exited");
        }
        return true;
      },
    });

    assert.equal(exited, true);
    assert.deepEqual(sleeps, [250, 250]);
    assert.equal(probes, 3);
  });
});

describe("startup recovery coordinator", () => {
  it("resolves inbound routing readiness only when marked ready", async () => {
    const coordinator = createStartupRecoveryCoordinator();
    let ready = false;
    void coordinator.ready.then(() => {
      ready = true;
    });

    await Promise.resolve();
    assert.equal(ready, false);

    coordinator.markReady();
    await coordinator.ready;
    assert.equal(ready, true);

    coordinator.markReady();
    await coordinator.ready;
    assert.equal(ready, true);
  });
});
