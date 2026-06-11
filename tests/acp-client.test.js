import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createNdjsonAcpProtocolLogger, openAcpConnection } from "../harnesses/acp-client.js";

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

  it("records the full ACP JSON-RPC transcript when a protocol logger is provided", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const protocolEntries = [];
    const connection = await openAcpConnection({
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "let buffer = '';",
          "process.stdin.on('data', (chunk) => {",
          "  buffer += chunk;",
          "  const lines = buffer.split('\\n');",
          "  buffer = lines.pop();",
          "  for (const line of lines) {",
          "    if (!line.trim()) continue;",
          "    const request = JSON.parse(line);",
          "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');",
          "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } }) + '\\n');",
          "  }",
          "});",
        ].join(""),
      ],
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
      args: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "let buffer = '';",
          "process.stdin.on('data', (chunk) => {",
          "  buffer += chunk;",
          "  const lines = buffer.split('\\n');",
          "  buffer = lines.pop();",
          "  for (const line of lines) {",
          "    if (!line.trim()) continue;",
          "    const request = JSON.parse(line);",
          "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } }) + '\\n');",
          "    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n'), 80);",
          "  }",
          "});",
        ].join(""),
      ],
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
