import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntimeDiagnosticsState, setDefaultRuntimeDiagnosticsStateForTesting } from "../diagnostics-config.js";
import { openAcpConnection } from "../harnesses/acp-client.js";

describe("ACP client process stderr", () => {
  /** @type {string | undefined} */
  let originalLogLevel;
  /** @type {string | undefined} */
  let originalAcpStderrLog;
  /** @type {string | undefined} */
  let originalAcpProtocolLog;

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
    originalAcpStderrLog = process.env.MADABOT_ACP_STDERR_LOG;
    originalAcpProtocolLog = process.env.MADABOT_ACP_PROTOCOL_LOG;
    process.env.LOG_LEVEL = "debug";
    delete process.env.MADABOT_ACP_STDERR_LOG;
    delete process.env.MADABOT_ACP_PROTOCOL_LOG;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (originalAcpStderrLog === undefined) delete process.env.MADABOT_ACP_STDERR_LOG;
    else process.env.MADABOT_ACP_STDERR_LOG = originalAcpStderrLog;
    if (originalAcpProtocolLog === undefined) delete process.env.MADABOT_ACP_PROTOCOL_LOG;
    else process.env.MADABOT_ACP_PROTOCOL_LOG = originalAcpProtocolLog;
    setDefaultRuntimeDiagnosticsStateForTesting(null);
  });

  it("drains child stderr without mirroring provider chatter into the bot log by default", async () => {
    const calls = await captureDebugLogs(async () => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", stderrFixtureCode("[codex:app-server] noisy\n".repeat(1000))],
      });
      await delay(100);
      await connection.close();
    });

    assert.deepEqual(calls, []);
  });

  it("can mirror child stderr when explicit ACP stderr logging is enabled", async () => {
    process.env.MADABOT_ACP_STDERR_LOG = "1";
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-stderr-env-"));
    setDefaultRuntimeDiagnosticsStateForTesting(createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: process.env,
      reloadIntervalMs: 0,
    }));

    const calls = await captureDebugLogs(async (calls) => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", stderrFixtureCode("visible stderr\n")],
      });
      await waitFor(() => calls.length > 0);
      await connection.close();
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "[harness:acp]");
    assert.equal(calls[0]?.[1], "[acp stderr]");
    assert.match(String(calls[0]?.[2]), /visible stderr/);
  });

  it("does not treat ACP stderr mirroring as seam capture config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-stderr-log-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    setDefaultRuntimeDiagnosticsStateForTesting(diagnostics);

    await diagnostics.update({
      capture: {
        seams: {
          "acp.protocol": { enabledUntil: "9999-12-31T23:59:59.999Z" },
        },
      },
    });
    const calls = await captureDebugLogs(async () => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", stderrFixtureCode("hidden stderr\n")],
      });
      await delay(100);
      await connection.close();
    });
    assert.deepEqual(calls, []);
  });

  it("reports child exit details and stderr tail when pending requests are rejected", async () => {
    const calls = await captureWarnLogs(async () => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", exitOnRequestFixtureCode()],
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

  it("reports child context and stderr tail when a request times out", async () => {
    const calls = await captureWarnLogs(async () => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", hangingRequestFixtureCode("session startup stalled\n")],
        fixtureCapture: null,
      });
      try {
        await assert.rejects(
          connection.sendRequest("session/new", { cwd: process.cwd() }, { timeoutMs: 50 }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /ACP request timed out after 50ms: session\/new/);
            assert.match(error.message, /command=/);
            assert.match(error.message, /pid=\d+/);
            assert.match(error.message, /pending=session\/new#1/);
            assert.match(error.message, /stderrTail=session startup stalled/);
            return true;
          },
        );
      } finally {
        await connection.close();
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "[harness:acp]");
    assert.equal(calls[0]?.[1], "ACP request timed out.");
    assert.deepEqual(calls[0]?.[2]?.pendingRequests, ["session/new#1"]);
    assert.equal(calls[0]?.[2]?.stderrTail, "session startup stalled");
  });

  it("merges supplied environment entries with the parent process environment", async () => {
    const previousSentinel = process.env.ACP_PARENT_ENV_SENTINEL;
    const sentinel = `sentinel-${Date.now()}`;
    process.env.ACP_PARENT_ENV_SENTINEL = sentinel;
    const connection = await openAcpConnection({
      command: process.execPath,
      args: ["-e", envEchoFixtureCode()],
      env: { ACP_CHILD_ENV: "override" },
      fixtureCapture: null,
    });
    try {
      assert.deepEqual(
        await connection.sendRequest("initialize", {}, { timeoutMs: 500 }),
        { parent: sentinel, child: "override" },
      );
    } finally {
      await connection.close();
      if (previousSentinel === undefined) {
        delete process.env.ACP_PARENT_ENV_SENTINEL;
      } else {
        process.env.ACP_PARENT_ENV_SENTINEL = previousSentinel;
      }
    }
  });

  it("captures the full ACP JSON-RPC transcript when fixture capture is provided", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const captureEntries = [];
    const connection = await openAcpConnection({
      command: process.execPath,
      args: ["-e", jsonRpcResponderFixtureCode()],
      fixtureCapture: {
        capture(entry) {
          captureEntries.push(structuredClone(entry));
        },
        waitForIdle: async () => {},
      },
    });
    try {
      assert.deepEqual(await connection.sendRequest("initialize", { client: "test" }), { ok: true });
      const notification = await connection.notifications.next();
      assert.equal(notification.value?.method, "session/update");

      assert.deepEqual(
        captureEntries.map((entry) => [entry.seam, entry.direction, entry.event]),
        [
          ["acp.protocol", "client_to_agent", "initialize"],
          ["acp.protocol", "agent_to_client", "response"],
          ["acp.protocol", "agent_to_client", "session/update"],
        ],
      );
      assert.deepEqual(/** @type {{ payload?: unknown }} */ (captureEntries[0]).payload, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { client: "test" },
      });
    } finally {
      await connection.close();
    }
  });

  it("refreshes selected request timeouts when ACP activity arrives", async () => {
    const connection = await openAcpConnection({
      command: process.execPath,
      args: ["-e", jsonRpcResponderFixtureCode({ responseDelayMs: 80, notificationFirst: true })],
      fixtureCapture: null,
    });
    try {
      assert.deepEqual(
        await connection.sendRequest("session/prompt", { prompt: "hello" }, { timeoutMs: 100, refreshOnActivity: true }),
        { ok: true },
      );
    } finally {
      await connection.close();
    }
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
 * @param {string} text
 * @returns {string}
 */
function stderrFixtureCode(text) {
  return [
    `require("node:fs").writeSync(2, ${JSON.stringify(text)});`,
    "setInterval(() => {}, 2147483647);",
  ].join("");
}

/**
 * @returns {string}
 */
function exitOnRequestFixtureCode() {
  return [
    "setInterval(() => {}, 2147483647);",
    "setTimeout(() => {",
    `  require("node:fs").writeSync(2, ${JSON.stringify("fatal provider detail\n")});`,
    "  process.exit(7);",
    "}, 20);",
  ].join("");
}

/**
 * @param {string} stderr
 * @returns {string}
 */
function hangingRequestFixtureCode(stderr) {
  return [
    "process.stdin.resume();",
    "setInterval(() => {}, 2147483647);",
    `require("node:fs").writeSync(2, ${JSON.stringify(stderr)});`,
  ].join("");
}

/**
 * @returns {string}
 */
function envEchoFixtureCode() {
  return [
    "setInterval(() => {}, 2147483647);",
    `const newline = ${JSON.stringify("\n")};`,
    "setTimeout(() => {",
    "  require('node:fs').writeSync(1, JSON.stringify({",
    "    jsonrpc: '2.0',",
    "    id: 1,",
    "    result: {",
    "      parent: process.env.ACP_PARENT_ENV_SENTINEL ?? null,",
    "      child: process.env.ACP_CHILD_ENV ?? null,",
    "    },",
    "  }) + newline);",
    "}, 20);",
  ].join("");
}

/**
 * @param {{ responseDelayMs?: number, notificationFirst?: boolean }} [options]
 * @returns {string}
 */
function jsonRpcResponderFixtureCode(options = {}) {
  const responseDelayMs = options.responseDelayMs ?? 0;
  const notificationFirst = options.notificationFirst === true;
  const writeResponse = "require('node:fs').writeSync(1, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + newline);";
  const writeNotification = "require('node:fs').writeSync(1, JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } }) + newline);";
  return [
    "setInterval(() => {}, 2147483647);",
    `const newline = ${JSON.stringify("\n")};`,
    "setTimeout(() => {",
    notificationFirst ? `  ${writeNotification}` : "",
    responseDelayMs > 0
      ? `  setTimeout(() => { ${writeResponse} }, ${responseDelayMs});`
      : `  ${writeResponse}`,
    notificationFirst ? "" : `  ${writeNotification}`,
    "}, 20);",
  ].join("");
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
