#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MODEL = "gpt-5.5";

/**
 * @param {string[]} args
 * @returns {{ model: string | null, timeoutMs: number, keep: boolean, prompt: string | null }}
 */
function parseArgs(args) {
  /** @type {string | null} */
  let model = DEFAULT_MODEL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let keep = true;
  /** @type {string | null} */
  let prompt = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      model = args[index + 1] ?? model;
      index += 1;
    } else if (arg === "--default-model") {
      model = null;
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(args[index + 1] ?? timeoutMs);
      index += 1;
    } else if (arg === "--cleanup") {
      keep = false;
    } else if (arg === "--prompt") {
      prompt = args[index + 1] ?? null;
      index += 1;
    }
  }
  return {
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    keep,
    prompt,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} notification
 * @returns {boolean}
 */
function isInterestingNotification(notification) {
  const method = notification.method;
  return typeof method === "string" && (
    method.startsWith("item/")
    || method === "turn/started"
    || method === "turn/completed"
    || method === "thread/status/changed"
  );
}

/**
 * @param {Record<string, unknown>} notification
 * @returns {Record<string, unknown>}
 */
function summarizeNotification(notification) {
  const method = typeof notification.method === "string" ? notification.method : "unknown";
  const params = isRecord(notification.params) ? notification.params : {};
  const item = isRecord(params.item) ? params.item : null;
  return {
    method,
    ...(item ? {
      item: {
        type: item.type,
        id: item.id,
        status: item.status,
        command: item.command,
        cwd: item.cwd,
        aggregatedOutput: item.aggregatedOutput,
        commandActions: item.commandActions,
      },
    } : {}),
    ...(!item ? { params } : {}),
  };
}

/**
 * @param {NodeJS.Timeout[]} timers
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(timers, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timers.push(timer);
  });
}

const options = parseArgs(process.argv.slice(2));
const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "real-codex-appserver-read-shape-"));
const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "real-codex-appserver-read-shape-logs-"));
const sampleText = Array.from(
  { length: 40 },
  (_, index) => `line ${String(index + 1).padStart(2, "0")} value`,
).join("\n") + "\n";
await fs.writeFile(path.join(workdir, "sample-lines.txt"), sampleText, "utf8");

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
/** @type {Array<{ predicate: (notification: Record<string, unknown>) => boolean, resolve: (notification: Record<string, unknown>) => void }>} */
const notificationWaiters = [];
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
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
      if (isRecord(message.error)) {
        waiter?.reject(new Error(JSON.stringify(message.error)));
      } else {
        waiter?.resolve(message.result);
      }
    } else if (typeof message.method === "string") {
      notifications.push(message);
      for (let index = notificationWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = notificationWaiters[index];
        if (waiter?.predicate(message)) {
          notificationWaiters.splice(index, 1);
          waiter.resolve(message);
        }
      }
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
 * @returns {Promise<unknown>}
 */
function request(method, params) {
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
 * @param {(notification: Record<string, unknown>) => boolean} predicate
 * @param {string} label
 * @returns {Promise<Record<string, unknown> | null>}
 */
function waitForNotification(predicate, label) {
  const existing = notifications.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiterIndex = notificationWaiters.findIndex((waiter) => waiter.resolve === resolve);
      if (waiterIndex !== -1) {
        notificationWaiters.splice(waiterIndex, 1);
      }
      console.error(`${label} timed out after ${options.timeoutMs}ms`);
      resolve(null);
    }, options.timeoutMs);
    timers.push(timer);
    notificationWaiters.push({
      predicate,
      resolve: (notification) => {
        clearTimeout(timer);
        resolve(notification);
      },
    });
  });
}

try {
  const initializeParams = {
    clientInfo: {
      name: "madabot-real-app-server-read-shape-smoke",
      title: "Madabot Real App Server Read Shape Smoke",
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
    model: options.model,
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    config: { projects: { [workdir]: { trust_level: "trusted" } } },
    baseInstructions: "You are a smoke-test agent. Use tools normally when asked to inspect files.",
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

  const prompt = options.prompt
    ?? "Read only lines 10-12 of sample-lines.txt using your file reading tool, then answer exactly DONE.";
  const turnStartParams = {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: workdir,
    model: options.model,
    effort: "low",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
    },
    summary: "none",
    outputSchema: null,
    personality: "none",
    serviceTier: null,
  };
  const turnStart = await request("turn/start", turnStartParams);
  const turn = isRecord(turnStart) && isRecord(turnStart.turn) ? turnStart.turn : null;
  const turnId = typeof turn?.id === "string" ? turn.id : null;
  await waitForNotification((notification) => {
    if (notification.method !== "turn/completed") {
      return false;
    }
    const params = isRecord(notification.params) ? notification.params : {};
    const completedTurn = isRecord(params.turn) ? params.turn : {};
    return !turnId || completedTurn.id === turnId;
  }, "turn/completed");
  await delay(timers, 1_000);

  const interesting = notifications.filter(isInterestingNotification);
  const commandNotifications = interesting.filter((notification) => {
    const params = isRecord(notification.params) ? notification.params : {};
    const item = isRecord(params.item) ? params.item : {};
    return item.type === "commandExecution";
  });
  const approvalRequests = notifications.filter((notification) => (
    notification.method === "item/commandExecution/requestApproval"
  ));

  console.log(JSON.stringify({
    ok: true,
    workdir,
    logDir,
    prompt,
    threadStartParams,
    initialize,
    turnStartParams,
    threadStart,
    turnStart,
    commandNotifications: commandNotifications.map(summarizeNotification),
    approvalRequests,
    interestingNotifications: interesting.map(summarizeNotification),
    stderr: stderr.slice(0, 4000),
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    workdir,
    logDir,
    error: error instanceof Error ? error.message : String(error),
    notifications: notifications.map(summarizeNotification),
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
