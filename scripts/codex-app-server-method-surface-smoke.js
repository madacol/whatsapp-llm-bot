#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {string[]} args
 * @returns {{ timeoutMs: number, keep: boolean }}
 */
function parseArgs(args) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let keep = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-ms") {
      timeoutMs = Number(args[index + 1] ?? timeoutMs);
      index += 1;
    } else if (arg === "--cleanup") {
      keep = false;
    }
  }
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    keep,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const options = parseArgs(process.argv.slice(2));
const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "real-codex-appserver-method-surface-"));
const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "real-codex-appserver-method-surface-logs-"));

/** @type {NodeJS.Timeout[]} */
const timers = [];
const proc = spawn("codex", ["app-server"], {
  cwd: workdir,
  env: {
    ...process.env,
    APP_SERVER_LOGS: logDir,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let stdoutBuffer = "";
let stderr = "";
/** @type {Record<string, unknown>[]} */
const notifications = [];
/** @type {Map<number, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void }>} */
const pending = new Map();

proc.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
  for (;;) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    /** @type {Record<string, unknown>} */
    let message;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) {
        continue;
      }
      message = parsed;
    } catch {
      continue;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      waiter?.resolve(message);
    } else if (typeof message.method === "string") {
      notifications.push(message);
    }
  }
});

proc.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

proc.on("close", (code) => {
  for (const [id, waiter] of pending.entries()) {
    waiter.reject(new Error(`codex app-server exited with code ${code ?? "unknown"} before response ${id}`));
  }
  pending.clear();
});

/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<Record<string, unknown>>}
 */
function requestRaw(method, params) {
  const id = nextId;
  nextId += 1;
  const payload = { jsonrpc: "2.0", id, method, params };
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timers.push(timer);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<unknown>}
 */
async function request(method, params) {
  const response = await requestRaw(method, params);
  if (isRecord(response.error)) {
    throw new Error(JSON.stringify(response.error));
  }
  return response.result;
}

try {
  const initializeParams = {
    clientInfo: {
      name: "madabot-real-app-server-method-surface-smoke",
      title: "Madabot Real App Server Method Surface Smoke",
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
  const initialize = await request("initialize", initializeParams);
  const threadStartParams = {
    cwd: workdir,
    modelProvider: "openai",
    model: "gpt-5.5",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    config: { projects: { [workdir]: { trust_level: "trusted" } } },
    baseInstructions: "You are a smoke-test agent.",
    developerInstructions: null,
    personality: "none",
    ephemeral: true,
  };
  const threadStart = await request("thread/start", threadStartParams);
  const thread = isRecord(threadStart) && isRecord(threadStart.thread) ? threadStart.thread : null;
  const threadId = typeof thread?.id === "string" ? thread.id : null;
  if (!threadId) {
    throw new Error(`thread/start did not return thread.id: ${JSON.stringify(threadStart)}`);
  }

  const serviceTierSettingsProbe = await requestRaw("thread/settings/update", {
    threadId,
    serviceTier: "fast",
  });
  if (isRecord(serviceTierSettingsProbe.error)) {
    throw new Error(`thread/settings/update serviceTier fast was rejected: ${JSON.stringify(serviceTierSettingsProbe.error)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    workdir,
    logDir,
    initialize,
    threadStartParams,
    threadStart,
    probes: [
      {
        method: "thread/settings/update",
        expected: "accepted",
        params: { threadId, serviceTier: "fast" },
        response: serviceTierSettingsProbe,
      },
    ],
    notifications,
    stderr: stderr.slice(0, 4000),
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    workdir,
    logDir,
    error: error instanceof Error ? error.message : String(error),
    notifications,
    stderr: stderr.slice(0, 4000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  proc.stdin.end();
  proc.kill("SIGTERM");
  if (!options.keep) {
    await fs.rm(workdir, { recursive: true, force: true });
    await fs.rm(logDir, { recursive: true, force: true });
  }
}
