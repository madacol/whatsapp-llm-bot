import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {{ type?: string } & Record<string, unknown>} ShutdownChildMessage
 */

/**
 * @param {unknown} message
 * @returns {ShutdownChildMessage}
 */
function toChildMessage(message) {
  return message && typeof message === "object"
    ? /** @type {ShutdownChildMessage} */ (message)
    : {};
}

/**
 * @param {unknown} message
 * @returns {string | undefined}
 */
function messageType(message) {
  return toChildMessage(message).type;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {(message: unknown) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<ShutdownChildMessage>}
 */
function waitForMessage(child, predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child message after ${timeoutMs}ms`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    /** @param {unknown} message */
    function onMessage(message) {
      if (!predicate(message)) {
        return;
      }
      cleanup();
      resolve(toChildMessage(message));
    }
    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Child exited before expected message: code=${code} signal=${signal}`));
    }
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("shutdown lifecycle process boundary", () => {
  it("keeps the process alive after SIGTERM while an active agent turn drains", async (t) => {
    const child = fork(path.join(__dirname, "fixtures", "shutdown-lifecycle-child.js"), {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [],
    });
    /** @type {ShutdownChildMessage[]} */
    const messages = [];
    child.on("message", (message) => messages.push(toChildMessage(message)));
    t.after(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    });

    await waitForMessage(child, (message) => messageType(message) === "ready");
    assert.equal(child.kill("SIGTERM"), true);
    await waitForMessage(child, (message) => messageType(message) === "active-wait-started");

    await delay(250);
    assert.equal(child.exitCode, null, `Expected child to stay alive while active turn drains, got messages ${JSON.stringify(messages)}`);
    assert.equal(child.signalCode, null);
    assert.ok(!messages.some((message) => message.type === "cleanup"), `Cleanup started before active turn finished: ${JSON.stringify(messages)}`);

    child.send("release-active-turn");
    const exit = await waitForExit(child);

    assert.deepEqual(exit, { code: 0, signal: null });
    assert.deepEqual(messages.map((message) => message.type), [
      "ready",
      "log",
      "active-wait-started",
      "active-wait-finished",
      "log",
      "cleanup",
    ]);
  });
});
