import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createActiveSessionDirectory } from "../harnesses/active-session-directory.js";

describe("createActiveSessionDirectory", () => {
  it("routes live input, cancellation, and idle waiting by chat/session key", async () => {
    const abortController = new AbortController();
    /** @type {string[]} */
    const steered = [];
    let interrupted = false;
    /** @type {() => void} */
    let resolveDone = () => {};
    const done = new Promise((resolve) => {
      resolveDone = () => resolve("ok");
    });
    const directory = createActiveSessionDirectory({ label: "Test" });
    const handle = {
      abortController,
      done,
      steer: async (text) => {
        steered.push(text);
        return true;
      },
      interrupt: async () => {
        interrupted = true;
        return true;
      },
      aborted: false,
    };

    directory.register("chat-1", handle);
    assert.deepEqual(directory.listKeys(), ["chat-1"]);

    assert.equal(await directory.injectMessage("chat-1", "follow up"), true);
    assert.deepEqual(steered, ["follow up"]);
    assert.equal(directory.cancel({ id: "chat-1", kind: "codex" }), true);
    assert.equal(handle.aborted, true);
    assert.equal(interrupted, true);

    const idle = directory.waitForIdle();
    resolveDone();
    assert.deepEqual(await idle, ["chat-1"]);
    directory.unregister("chat-1", handle);
    assert.equal(directory.cancel("chat-1"), false);
  });

  it("falls back to abort when interrupt fails", async () => {
    const abortController = new AbortController();
    /** @type {unknown[]} */
    const interruptErrors = [];
    const directory = createActiveSessionDirectory({
      label: "Test",
      onInterruptError: (error) => {
        interruptErrors.push(error);
      },
    });
    const failure = new Error("interrupt unavailable");
    const handle = {
      abortController,
      done: Promise.resolve(),
      interrupt: async () => {
        throw failure;
      },
      aborted: false,
    };

    directory.register("chat-1", handle);
    assert.equal(directory.cancel("chat-1"), true);
    await Promise.resolve();

    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(interruptErrors, [failure]);
  });
});
