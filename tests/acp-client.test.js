import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { openAcpConnection } from "../harnesses/acp-client.js";

describe("ACP client process stderr", () => {
  /** @type {string | undefined} */
  let originalLogLevel;
  /** @type {string | undefined} */
  let originalAcpStderrLog;

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
    originalAcpStderrLog = process.env.MADABOT_ACP_STDERR_LOG;
    process.env.LOG_LEVEL = "debug";
    delete process.env.MADABOT_ACP_STDERR_LOG;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (originalAcpStderrLog === undefined) delete process.env.MADABOT_ACP_STDERR_LOG;
    else process.env.MADABOT_ACP_STDERR_LOG = originalAcpStderrLog;
  });

  it("drains child stderr without mirroring provider chatter into the bot log by default", async () => {
    const calls = await captureDebugLogs(async () => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", "process.stderr.write('[codex:app-server] noisy\\\\n'.repeat(1000)); setTimeout(() => {}, 1000);"],
      });
      await delay(100);
      await connection.close();
    });

    assert.deepEqual(calls, []);
  });

  it("can mirror child stderr when explicit ACP stderr logging is enabled", async () => {
    process.env.MADABOT_ACP_STDERR_LOG = "1";

    const calls = await captureDebugLogs(async (calls) => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", "process.stderr.write('visible stderr\\\\n'); setTimeout(() => {}, 1000);"],
      });
      await waitFor(() => calls.length > 0);
      await connection.close();
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "[harness:acp]");
    assert.equal(calls[0]?.[1], "[acp stderr]");
    assert.match(String(calls[0]?.[2]), /visible stderr/);
  });

  it("reports child exit details and stderr tail when pending requests are rejected", async () => {
    const calls = await captureWarnLogs(async () => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.setEncoding('utf8');",
            "process.stdin.once('data', () => {",
            "  process.stderr.write('fatal provider detail\\n');",
            "  process.exit(7);",
            "});",
          ].join(""),
        ],
      });

      await assert.rejects(
        connection.sendRequest("session/prompt", { prompt: "hello" }),
        /ACP connection closed.*exitCode=7.*pending=session\/prompt#1/,
      );
      await connection.close();
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "[harness:acp]");
    assert.equal(calls[0]?.[1], "ACP child process closed unexpectedly.");
    const details = calls[0]?.[2];
    assert.equal(details?.command, process.execPath);
    assert.equal(typeof details?.pid, "number");
    assert.equal(details?.exitCode, 7);
    assert.equal(details?.signal, null);
    assert.deepEqual(details?.pendingRequests, ["session/prompt#1"]);
    assert.equal(details?.stderrTail, "fatal provider detail");
  });
});

/**
 * @param {(calls: any[][]) => Promise<void>} fn
 * @returns {Promise<any[][]>}
 */
async function captureDebugLogs(fn) {
  /** @type {any[][]} */
  const calls = [];
  const originalDebug = console.debug;
  console.debug = /** @type {typeof console.debug} */ ((...args) => {
    calls.push(args);
  });
  try {
    await fn(calls);
  } finally {
    console.debug = originalDebug;
  }
  return calls;
}

/**
 * @param {(calls: any[][]) => Promise<void>} fn
 * @returns {Promise<any[][]>}
 */
async function captureWarnLogs(fn) {
  /** @type {any[][]} */
  const calls = [];
  const originalWarn = console.warn;
  console.warn = /** @type {typeof console.warn} */ ((...args) => {
    calls.push(args);
  });
  try {
    await fn(calls);
  } finally {
    console.warn = originalWarn;
  }
  return calls;
}

/**
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      return;
    }
    await delay(10);
  }
}
