#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_OUTPUT = path.join("tests", "fixtures", "codex-app-server-approval-delete-add-traffic.json");
const NORMALIZED_WORKDIR = "/tmp/codex-app-server-approval-delete-add";
const NORMALIZED_TARGET = `${NORMALIZED_WORKDIR}/approval-delete-add.md`;

/**
 * @param {string[]} args
 * @returns {{ output: string, timeoutMs: number, model: string | null, keep: boolean }}
 */
function parseArgs(args) {
  let output = DEFAULT_OUTPUT;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  /** @type {string | null} */
  let model = DEFAULT_MODEL;
  let keep = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      output = args[index + 1] ?? output;
      index += 1;
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(args[index + 1] ?? timeoutMs);
      index += 1;
    } else if (arg === "--model") {
      model = args[index + 1] ?? model;
      index += 1;
    } else if (arg === "--default-model") {
      model = null;
    } else if (arg === "--keep") {
      keep = true;
    }
  }
  return {
    output,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    model,
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

/**
 * @param {string} text
 * @param {string} workdir
 * @param {string} targetPath
 * @param {string} logDir
 * @returns {string}
 */
function normalizeText(text, workdir, targetPath, logDir) {
  return text
    .split(targetPath).join(NORMALIZED_TARGET)
    .split(workdir).join(NORMALIZED_WORKDIR)
    .split(logDir).join(`${NORMALIZED_WORKDIR}-logs`);
}

/**
 * @param {unknown} value
 * @param {string} workdir
 * @param {string} targetPath
 * @param {string} logDir
 * @returns {unknown}
 */
function normalizeFixtureValue(value, workdir, targetPath, logDir) {
  if (typeof value === "string") {
    return normalizeText(value, workdir, targetPath, logDir);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFixtureValue(entry, workdir, targetPath, logDir));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeFixtureValue(entry, workdir, targetPath, logDir)]),
  );
}

/**
 * @param {string} method
 * @returns {Record<string, unknown>}
 */
function responseForServerRequest(method) {
  if (/requestApproval$/i.test(method) || /approval/i.test(method)) {
    return { decision: "accept" };
  }
  return {};
}

/**
 * @param {string} targetPath
 * @returns {Promise<{ exists: boolean, text?: string, error?: string }>}
 */
async function snapshotTarget(targetPath) {
  try {
    return { exists: true, text: await fs.readFile(targetPath, "utf8") };
  } catch (error) {
    return {
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-approval-delete-add-"));
const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-approval-delete-add-logs-"));
const targetPath = path.join(workdir, "approval-delete-add.md");
const beforeText = "# Original approval file\nThis file must be rewritten through one delete-plus-add apply_patch.\n";
await fs.writeFile(targetPath, beforeText, "utf8");

/** @type {NodeJS.Timeout[]} */
const timers = [];
/** @type {Array<Record<string, unknown>>} */
const traffic = [];
/** @type {Array<Record<string, unknown>>} */
const serverRequests = [];
/** @type {Array<Record<string, unknown>>} */
const approvalPhaseNotifications = [];
/** @type {Array<Record<string, unknown>>} */
const snapshots = [{
  label: "before-turn",
  targetPath,
  snapshot: await snapshotTarget(targetPath),
}];
/** @type {Map<number, { method: string, resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
const pending = new Map();
let nextId = 1;
let stdoutBuffer = "";
let stderr = "";

const proc = spawn("codex", ["app-server"], {
  cwd: workdir,
  env: { ...process.env, APP_SERVER_LOGS: logDir },
  stdio: ["pipe", "pipe", "pipe"],
});

/**
 * @param {"client_to_appserver" | "appserver_to_client"} direction
 * @param {Record<string, unknown>} message
 */
function recordTraffic(direction, message) {
  traffic.push({
    index: traffic.length,
    direction,
    at: new Date().toISOString(),
    ...(typeof message.id === "number" || typeof message.id === "string" ? { id: message.id } : {}),
    ...(typeof message.method === "string" ? { method: message.method } : {}),
    message,
  });
}

/**
 * @param {Record<string, unknown>} message
 */
function writeMessage(message) {
  const payload = { jsonrpc: "2.0", ...message };
  recordTraffic("client_to_appserver", payload);
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleServerRequest(message) {
  const method = typeof message.method === "string" ? message.method : "unknown";
  const beforeReply = await snapshotTarget(targetPath);
  const snapshot = {
    label: `server-request-before-reply:${method}`,
    trafficIndex: traffic.length - 1,
    targetPath,
    snapshot: beforeReply,
  };
  snapshots.push(snapshot);
  serverRequests.push({ message, snapshot });
  const result = responseForServerRequest(method);
  writeMessage({ id: message.id, result });
}

/**
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
function isFileChangeNotification(message) {
  const params = isRecord(message.params) ? message.params : null;
  const item = isRecord(params?.item) ? params.item : null;
  return item?.type === "fileChange";
}

/**
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
function isApprovalPhaseNotification(message) {
  return message.method === "item/autoApprovalReview/started"
    || message.method === "item/autoApprovalReview/completed"
    || message.method === "guardianWarning"
    || isFileChangeNotification(message);
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function maybeSnapshotApprovalPhase(message) {
  if (!isApprovalPhaseNotification(message)) {
    return;
  }
  const snapshot = {
    label: `appserver-notification:${String(message.method ?? "unknown")}`,
    trafficIndex: traffic.length - 1,
    targetPath,
    snapshot: await snapshotTarget(targetPath),
  };
  snapshots.push(snapshot);
  approvalPhaseNotifications.push({ message, snapshot });
}

proc.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
  void (async () => {
    for (;;) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      /** @type {Record<string, unknown>} */
      let message;
      try {
        const parsed = JSON.parse(line);
        if (!isRecord(parsed)) continue;
        message = parsed;
      } catch {
        continue;
      }
      recordTraffic("appserver_to_client", message);
      await maybeSnapshotApprovalPhase(message);
      if (typeof message.id === "number" && pending.has(message.id) && typeof message.method !== "string") {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (isRecord(message.error)) {
          waiter?.reject(new Error(JSON.stringify(message.error)));
        } else {
          waiter?.resolve(message.result);
        }
        continue;
      }
      if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
        await handleServerRequest(message);
      }
    }
  })().catch((error) => {
    stderr += `\n[capture handler error] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
  });
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
  writeMessage({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timers.push(timer);
    pending.set(id, {
      method,
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
 * @param {(message: Record<string, unknown>) => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitForTraffic(predicate) {
  const started = Date.now();
  while (!traffic.some((entry) => isRecord(entry.message) && predicate(/** @type {Record<string, unknown>} */ (entry.message)))) {
    if (Date.now() - started > options.timeoutMs) {
      throw new Error(`Timed out waiting for traffic after ${options.timeoutMs}ms`);
    }
    await delay(timers, 250);
  }
}

try {
  const initialize = await request("initialize", {
    clientInfo: {
      name: "madabot-codex-app-server-approval-delete-add-capture",
      title: "Madabot Codex App Server Approval Delete/Add Capture",
      version: "1.0.0",
    },
    capabilities: { experimentalApi: true },
  });
  const threadStart = await request("thread/start", {
    cwd: workdir,
    modelProvider: "openai",
    model: options.model,
    approvalPolicy: "on-request",
    approvalsReviewer: null,
    sandbox: "read-only",
    config: { projects: { [workdir]: { trust_level: "trusted" } } },
    baseInstructions: "You are a smoke-test agent. Use apply_patch exactly when requested.",
    developerInstructions: null,
    personality: "none",
    ephemeral: true,
  });
  const thread = isRecord(threadStart) && isRecord(threadStart.thread) ? threadStart.thread : null;
  const threadId = typeof thread?.id === "string" ? thread.id : null;
  if (!threadId) {
    throw new Error(`thread/start did not return thread.id: ${JSON.stringify(threadStart)}`);
  }

  const prompt = [
    `Use apply_patch to rewrite exactly ${targetPath}.`,
    "Use one single apply_patch invocation.",
    `The patch must contain "*** Delete File: ${targetPath}" followed by "*** Add File: ${targetPath}".`,
    "The replacement content must be exactly:",
    "# Rewritten approval file",
    "This content was produced after the approval-blocking delete-plus-add rewrite.",
    "After the patch, answer exactly DONE.",
  ].join("\n");
  const turnStart = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: workdir,
    model: options.model,
    effort: "low",
    approvalPolicy: "on-request",
    approvalsReviewer: null,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    summary: "none",
    outputSchema: null,
    personality: "none",
    serviceTier: null,
  });
  await waitForTraffic((message) => message.method === "turn/completed");
  await delay(timers, 1_000);
  snapshots.push({
    label: "after-turn",
    targetPath,
    snapshot: await snapshotTarget(targetPath),
  });

  if (serverRequests.length === 0) {
    const fileChange = traffic.find((entry) => isRecord(entry.message) && isFileChangeNotification(/** @type {Record<string, unknown>} */ (entry.message)));
    if (!fileChange) {
      throw new Error("No app-server client requests or fileChange notifications were captured.");
    }
  }

  const fixture = {
    name: "codex-app-server-approval-delete-add-traffic",
    description: "Real codex app-server JSON-RPC traffic for an approval-blocking existing-file same-path delete/add apply_patch rewrite.",
    capturedAt: new Date().toISOString(),
    workdir,
    logDir,
    targetPath,
    beforeText,
    initialize,
    threadStart,
    turnStart,
    traffic,
    serverRequests,
    approvalPhaseNotifications,
    snapshots,
    stderr: stderr.slice(0, 8000),
  };
  const normalizedFixture = normalizeFixtureValue(fixture, workdir, targetPath, logDir);
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(normalizedFixture, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    workdir,
    logDir,
    serverRequestMethods: serverRequests.map((entry) => isRecord(entry.message) ? entry.message.method : undefined),
    approvalPhaseMethods: approvalPhaseNotifications.map((entry) => isRecord(entry.message) ? entry.message.method : undefined),
    snapshotLabels: snapshots.map((snapshot) => snapshot.label),
  }, null, 2));
} catch (error) {
  snapshots.push({
    label: "after-error",
    targetPath,
    snapshot: await snapshotTarget(targetPath),
  });
  const failure = {
    name: "codex-app-server-approval-delete-add-traffic",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    workdir,
    logDir,
    targetPath,
    beforeText,
    traffic,
    serverRequests,
    approvalPhaseNotifications,
    snapshots,
    stderr: stderr.slice(0, 8000),
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(normalizeFixtureValue(failure, workdir, targetPath, logDir), null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: false,
    output: options.output,
    workdir,
    logDir,
    error: error instanceof Error ? error.message : String(error),
    serverRequestMethods: serverRequests.map((entry) => isRecord(entry.message) ? entry.message.method : undefined),
    approvalPhaseMethods: approvalPhaseNotifications.map((entry) => isRecord(entry.message) ? entry.message.method : undefined),
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
