import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntimeDiagnosticsState, setDefaultRuntimeDiagnosticsStateForTesting } from "../diagnostics-config.js";
import { createNdjsonAcpProtocolLogger, createRuntimeGatedAcpProtocolLogger, getDefaultAcpProtocolLogger, openAcpConnection } from "../harnesses/acp-client.js";

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

  it("provides a default ACP protocol logger that stays quiet unless explicitly enabled", () => {
    assert.notEqual(getDefaultAcpProtocolLogger(), null);

    process.env.MADABOT_ACP_PROTOCOL_LOG = "1";
    assert.notEqual(getDefaultAcpProtocolLogger(), null);
  });

  it("observes runtime toggles without replacing the ACP protocol logger", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-protocol-log-"));
    const configPath = path.join(tempDir, "logging.json");
    const logger = createRuntimeGatedAcpProtocolLogger(
      path.join(tempDir, "acp.ndjson"),
      createRuntimeDiagnosticsState({ configPath, env: {}, reloadIntervalMs: 0 }),
    );

    await logger.write({
      timestamp: "2026-06-11T12:00:00.000Z",
      direction: "client_to_agent",
      kind: "request",
      id: 1,
      method: "initialize",
      message: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    assert.deepEqual((await fs.readdir(tempDir)).sort(), []);

    await fs.writeFile(configPath, JSON.stringify({ acpProtocolLog: true }));
    await logger.write({
      timestamp: "2026-06-11T12:01:00.000Z",
      direction: "agent_to_client",
      kind: "notification",
      method: "session/update",
      message: { jsonrpc: "2.0", method: "session/update" },
    });

    assert.deepEqual((await fs.readdir(tempDir)).sort(), [
      "acp.2026-06-11T12Z.ndjson",
      "logging.json",
    ]);
    assert.match(
      await fs.readFile(path.join(tempDir, "acp.2026-06-11T12Z.ndjson"), "utf8"),
      /"method":"session\/update"/,
    );
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

  it("observes runtime ACP stderr logging toggles without reconnecting the manager", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-stderr-log-"));
    const diagnostics = createRuntimeDiagnosticsState({
      configPath: path.join(tempDir, "logging.json"),
      env: {},
      reloadIntervalMs: 0,
    });
    setDefaultRuntimeDiagnosticsStateForTesting(diagnostics);

    const hiddenCalls = await captureDebugLogs(async () => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", stderrFixtureCode("hidden stderr\n")],
      });
      await delay(100);
      await connection.close();
    });
    assert.deepEqual(hiddenCalls, []);

    await diagnostics.update({ acpStderrLog: true });
    const visibleCalls = await captureDebugLogs(async (calls) => {
      const connection = await openAcpConnection({
        command: process.execPath,
        args: ["-e", stderrFixtureCode("runtime stderr\n")],
      });
      await waitFor(() => calls.length > 0);
      await connection.close();
    });
    assert.match(String(visibleCalls[0]?.[2]), /runtime stderr/);
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

  it("records the full ACP JSON-RPC transcript when a protocol logger is provided", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const protocolEntries = [];
    const connection = await openAcpConnection({
      command: process.execPath,
      args: ["-e", jsonRpcResponderFixtureCode()],
      protocolLogger: {
        write(entry) {
          protocolEntries.push(structuredClone(entry));
        },
      },
    });
    try {
      assert.deepEqual(await connection.sendRequest("initialize", { client: "test" }), { ok: true });
      const notification = await connection.notifications.next();
      assert.equal(notification.value?.method, "session/update");

      assert.deepEqual(
        protocolEntries.map((entry) => [entry.direction, entry.kind, entry.method ?? null, entry.id ?? null]),
        [
          ["client_to_agent", "request", "initialize", 1],
          ["agent_to_client", "response", null, 1],
          ["agent_to_client", "notification", "session/update", null],
        ],
      );
      assert.deepEqual(/** @type {{ message?: unknown }} */ (protocolEntries[0]).message, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { client: "test" },
      });
      assert.equal(typeof protocolEntries[0]?.timestamp, "string");
    } finally {
      await connection.close();
    }
  });

  it("refreshes selected request timeouts when ACP activity arrives", async () => {
    const connection = await openAcpConnection({
      command: process.execPath,
      args: ["-e", jsonRpcResponderFixtureCode({ responseDelayMs: 80, notificationFirst: true })],
      protocolLogger: null,
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

describe("ACP protocol log rotation", () => {
  it("writes ACP protocol entries to UTC hourly log files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-protocol-log-"));
    const logger = createNdjsonAcpProtocolLogger(path.join(tempDir, "acp.ndjson"));

    await logger.write({
      timestamp: "2026-06-04T13:12:00.000Z",
      direction: "client_to_agent",
      kind: "request",
      id: 1,
      method: "initialize",
      message: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    await logger.write({
      timestamp: "2026-06-04T14:00:01.000Z",
      direction: "agent_to_client",
      kind: "notification",
      method: "session/update",
      message: { jsonrpc: "2.0", method: "session/update" },
    });

    assert.deepEqual((await fs.readdir(tempDir)).sort(), [
      "acp.2026-06-04T13Z.ndjson",
      "acp.2026-06-04T14Z.ndjson",
    ]);
    assert.match(
      await fs.readFile(path.join(tempDir, "acp.2026-06-04T13Z.ndjson"), "utf8"),
      /"method":"initialize"/,
    );
    assert.match(
      await fs.readFile(path.join(tempDir, "acp.2026-06-04T14Z.ndjson"), "utf8"),
      /"method":"session\/update"/,
    );
  });

  it("deletes matching hourly ACP protocol logs older than 24 hours when a new hour starts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-protocol-log-"));
    await fs.writeFile(path.join(tempDir, "acp.2026-06-03T12Z.ndjson"), "{}\n");
    await fs.writeFile(path.join(tempDir, "acp.2026-06-03T13Z.ndjson"), "{}\n");
    await fs.writeFile(path.join(tempDir, "other.2026-06-03T12Z.ndjson"), "{}\n");
    const logger = createNdjsonAcpProtocolLogger(path.join(tempDir, "acp.ndjson"));

    await logger.write({
      timestamp: "2026-06-04T13:05:00.000Z",
      direction: "client_to_agent",
      kind: "request",
      id: 1,
      method: "initialize",
      message: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });

    assert.deepEqual((await fs.readdir(tempDir)).sort(), [
      "acp.2026-06-03T13Z.ndjson",
      "acp.2026-06-04T13Z.ndjson",
      "other.2026-06-03T12Z.ndjson",
    ]);
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
