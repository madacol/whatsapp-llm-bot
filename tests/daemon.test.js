import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createDaemon } from "../daemon.js";

describe("createDaemon", () => {
  it("calls init once on start", async () => {
    const init = mock.fn(async () => {});
    const poll = mock.fn(async () => {});

    const stop = createDaemon({ init, poll, intervalMs: 100_000, label: "test" });
    // Give init a tick to run
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(init.mock.callCount(), 1);
    assert.equal(poll.mock.callCount(), 0);
    stop();
  });

  it("calls poll on each interval tick", async () => {
    const poll = mock.fn(async () => {});

    const stop = createDaemon({ poll, intervalMs: 30, label: "test" });
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(poll.mock.callCount() >= 1, `Expected at least 1 poll call, got ${poll.mock.callCount()}`);
    stop();
  });

  it("returns a stop function that clears the interval", async () => {
    const poll = mock.fn(async () => {});

    const stop = createDaemon({ poll, intervalMs: 20, label: "test" });
    stop();
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(poll.mock.callCount(), 0);
  });

  it("does not crash when init throws", async () => {
    const init = mock.fn(async () => { throw new Error("init boom"); });
    const poll = mock.fn(async () => {});

    const stop = createDaemon({ init, poll, intervalMs: 100_000, label: "test" });
    await new Promise((r) => setTimeout(r, 10));

    // Should not throw, just log
    assert.equal(poll.mock.callCount(), 0);
    stop();
  });

  it("does not crash when poll throws", async () => {
    const poll = mock.fn(async () => { throw new Error("poll boom"); });

    const stop = createDaemon({ poll, intervalMs: 20, label: "test" });
    await new Promise((r) => setTimeout(r, 60));

    // Should not throw, just log
    assert.ok(poll.mock.callCount() >= 1);
    stop();
  });
});
