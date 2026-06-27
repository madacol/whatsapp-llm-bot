import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import { getDefaultRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { getDefaultFixtureCapture } from "../diagnostics/capture.js";

const log = createLogger("harness:acp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const requireFromHere = createRequire(import.meta.url);
const ACP_STDERR_TAIL_MAX_CHARS = 4_000;
const ACP_COMMAND_PACKAGES = new Map([
  ["codex-acp", "@agentclientprotocol/codex-acp"],
]);

/**
 * @typedef {{
 *   method: string,
 *   resolve: (value: unknown) => void,
 *   reject: (error: Error) => void,
 *   refreshTimeout?: () => void,
 * }} PendingRequest
 */

/**
 * @typedef {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   handleRequest?: (message: Record<string, unknown>) => Promise<unknown>,
 *   fixtureCapture?: import("../diagnostics/capture.js").FixtureCapture | null,
 * }} OpenAcpConnectionOptions
 */

/**
 * @typedef {{
 *   proc: import("node:child_process").ChildProcessWithoutNullStreams,
 *   sendRequest: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number, refreshOnActivity?: boolean }) => Promise<unknown>,
 *   sendNotification: (method: string, params?: Record<string, unknown>) => void,
 *   notifications: AsyncGenerator<Record<string, unknown>>,
 *   close: () => Promise<void>,
 * }} AcpConnection
 */

/**
 * @returns {{
 *   push: (value: Record<string, unknown>) => void,
 *   end: () => void,
 *   iterate: () => AsyncGenerator<Record<string, unknown>>,
 * }}
 */
function createNotificationQueue() {
  /** @type {Record<string, unknown>[]} */
  const values = [];
  /** @type {Array<(value: Record<string, unknown> | null) => void>} */
  const waiters = [];
  let ended = false;

  return {
    push(value) {
      if (ended) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
      } else {
        values.push(value);
      }
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()?.(null);
      }
    },
    async *iterate() {
      while (true) {
        if (values.length > 0) {
          const value = values.shift();
          if (value) {
            yield value;
          }
          continue;
        }
        if (ended) {
          return;
        }
        const next = await new Promise((resolve) => {
          waiters.push(resolve);
        });
        if (!next) {
          return;
        }
        yield /** @type {Record<string, unknown>} */ (next);
      }
    },
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function jsonRpcErrorMessage(error) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "ACP request failed.";
}

/**
 * @param {unknown} error
 * @returns {number}
 */
function jsonRpcErrorCode(error) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "number") {
    return error.code;
  }
  return -32000;
}

/**
 * @param {string} method
 * @param {number} timeoutMs
 * @param {{
 *   command: string,
 *   pid?: number,
 *   cwd?: string | null,
 *   pendingRequests: string[],
 *   stderrTail?: string,
 * }} details
 * @returns {Error}
 */
function createRequestTimeoutError(method, timeoutMs, details) {
  const parts = [
    `ACP request timed out after ${timeoutMs}ms: ${method}`,
    `command=${details.command}`,
  ];
  if (typeof details.pid === "number") {
    parts.push(`pid=${details.pid}`);
  }
  if (details.cwd) {
    parts.push(`cwd=${details.cwd}`);
  }
  if (details.pendingRequests.length > 0) {
    parts.push(`pending=${details.pendingRequests.join(",")}`);
  }
  if (details.stderrTail) {
    parts.push(`stderrTail=${details.stderrTail}`);
  }
  return new Error(parts.join(" "));
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 * @returns {NodeJS.ProcessEnv | undefined}
 */
function buildChildEnvironment(env) {
  return env ? { ...process.env, ...env } : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function getErrorCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} packageDir
 * @param {string} command
 * @returns {string | null}
 */
function resolvePackageBinTarget(packageDir, command) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (!isRecord(packageJson)) {
      return null;
    }
    const bin = packageJson.bin;
    let relativeTarget = null;
    if (typeof bin === "string" && typeof packageJson.name === "string" && path.basename(packageJson.name) === command) {
      relativeTarget = bin;
    } else if (isRecord(bin) && typeof bin[command] === "string") {
      relativeTarget = bin[command];
    }
    if (!relativeTarget) {
      return null;
    }
    const target = path.join(packageDir, relativeTarget);
    return fs.existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} command
 * @returns {string | null}
 */
function resolveInstalledPackageBin(command) {
  const nodeModules = path.join(REPO_ROOT, "node_modules");
  let entries;
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      let scopedEntries;
      try {
        scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        const target = resolvePackageBinTarget(path.join(entryPath, scopedEntry.name), command);
        if (target) {
          return target;
        }
      }
      continue;
    }
    const target = resolvePackageBinTarget(entryPath, command);
    if (target) {
      return target;
    }
  }

  return null;
}

/**
 * @param {string} command
 * @returns {string | null}
 */
function resolveKnownPackageBin(command) {
  const packageName = ACP_COMMAND_PACKAGES.get(command);
  if (!packageName) {
    return null;
  }
  try {
    const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
    return resolvePackageBinTarget(path.dirname(packageJsonPath), command);
  } catch {
    try {
      const entrypoint = requireFromHere.resolve(packageName);
      return fs.existsSync(entrypoint) ? entrypoint : null;
    } catch {
      return null;
    }
  }
}

/**
 * @param {string} command
 * @returns {string}
 */
export function resolveAcpCommandPath(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }
  const binName = process.platform === "win32" ? `${command}.cmd` : command;
  const localBin = path.join(REPO_ROOT, "node_modules", ".bin", binName);
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  const knownPackageBin = resolveKnownPackageBin(command);
  if (knownPackageBin) {
    return knownPackageBin;
  }
  return resolveInstalledPackageBin(command) ?? command;
}

/**
 * @param {{ phase: "startup" | "runtime", command: string, resolvedCommand: string, cwd?: string | null, error: unknown }} input
 * @returns {Error}
 */
function createAcpProcessError(input) {
  const parts = [
    input.phase === "startup"
      ? `Failed to start ACP command "${input.command}".`
      : `ACP command process error "${input.command}".`,
    `resolved=${input.resolvedCommand}`,
  ];
  if (input.cwd) {
    parts.push(`cwd=${input.cwd}`);
  }
  const code = getErrorCode(input.error);
  if (code) {
    parts.push(`code=${code}`);
  }
  parts.push(getErrorMessage(input.error));
  return new Error(parts.join(" "), { cause: input.error });
}

/**
 * @param {{
 *   command: string,
 *   resolvedCommand: string,
 *   cwd?: string | null,
 *   error: unknown,
 *   pendingRequests: string[],
 *   stderrTail?: string,
 * }} input
 * @returns {Error}
 */
function createAcpConnectionWriteError(input) {
  const parts = [
    "ACP connection write failed.",
    `command=${input.command}`,
    `resolved=${input.resolvedCommand}`,
  ];
  if (input.cwd) {
    parts.push(`cwd=${input.cwd}`);
  }
  const code = getErrorCode(input.error);
  if (code) {
    parts.push(`code=${code}`);
  }
  if (input.pendingRequests.length > 0) {
    parts.push(`pending=${input.pendingRequests.join(",")}`);
  }
  if (input.stderrTail) {
    parts.push(`stderrTail=${input.stderrTail}`);
  }
  parts.push(getErrorMessage(input.error));
  return new Error(parts.join(" "), { cause: input.error });
}

/**
 * @param {{
 *   command: string,
 *   resolvedCommand: string,
 *   cwd?: string | null,
 *   pendingRequests: string[],
 *   stderrTail?: string,
 * }} input
 * @returns {Error}
 */
function createAcpConnectionUnavailableError(input) {
  const parts = [
    "ACP connection is not writable.",
    `command=${input.command}`,
    `resolved=${input.resolvedCommand}`,
  ];
  if (input.cwd) {
    parts.push(`cwd=${input.cwd}`);
  }
  if (input.pendingRequests.length > 0) {
    parts.push(`pending=${input.pendingRequests.join(",")}`);
  }
  if (input.stderrTail) {
    parts.push(`stderrTail=${input.stderrTail}`);
  }
  return new Error(parts.join(" "));
}

/**
 * @param {import("node:child_process").ChildProcess} proc
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForProcessExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best-effort shutdown
      }
      resolve();
    }, timeoutMs);
    timer.unref?.();
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * @returns {boolean}
 */
function shouldLogAcpChildStderr() {
  return getDefaultRuntimeDiagnosticsState().isAcpStderrLogEnabled();
}

/**
 * @param {string} current
 * @param {string} chunk
 * @returns {string}
 */
function appendStderrTail(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > ACP_STDERR_TAIL_MAX_CHARS ? next.slice(-ACP_STDERR_TAIL_MAX_CHARS) : next;
}

/**
 * @param {string} value
 * @returns {string}
 */
function cleanStderrTail(value) {
  return value.trim();
}

/**
 * @param {Record<string, unknown>} message
 * @returns {"request" | "response" | "notification"}
 */
function classifyAcpProtocolMessage(message) {
  if (typeof message.method === "string" && message.id !== undefined) {
    return "request";
  }
  if (typeof message.method === "string") {
    return "notification";
  }
  return "response";
}

/**
 * @param {import("../diagnostics/capture.js").FixtureCapture | null} fixtureCapture
 * @param {"client_to_agent" | "agent_to_client"} direction
 * @param {Record<string, unknown>} message
 * @returns {void}
 */
function captureAcpProtocolMessage(fixtureCapture, direction, message) {
  if (!fixtureCapture) {
    return;
  }
  const kind = classifyAcpProtocolMessage(message);
  fixtureCapture.capture({
    seam: "acp.protocol",
    direction,
    event: typeof message.method === "string" ? message.method : kind,
    payload: message,
  });
}

/**
 * @param {Map<number, PendingRequest>} pendingRequests
 * @returns {string[]}
 */
function pendingRequestSummaries(pendingRequests) {
  return [...pendingRequests].map(([id, pending]) => `${pending.method}#${id}`);
}

/**
 * @param {{
 *   exitCode: number | null,
 *   signal: NodeJS.Signals | null,
 *   pendingRequests: string[],
 * }} details
 * @returns {string}
 */
function formatConnectionClosedMessage(details) {
  const parts = [
    "ACP connection closed.",
    `exitCode=${details.exitCode === null ? "null" : details.exitCode}`,
    `signal=${details.signal === null ? "null" : details.signal}`,
  ];
  if (details.pendingRequests.length > 0) {
    parts.push(`pending=${details.pendingRequests.join(",")}`);
  }
  return parts.join(" ");
}

/**
 * @param {OpenAcpConnectionOptions} options
 * @returns {Promise<AcpConnection>}
 */
export async function openAcpConnection(options) {
  const fixtureCapture = options.fixtureCapture === undefined ? getDefaultFixtureCapture() : options.fixtureCapture;
  const childEnv = buildChildEnvironment(options.env);
  const resolvedCommand = resolveAcpCommandPath(options.command);
  const proc = spawn(resolvedCommand, options.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(childEnv ? { env: childEnv } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const queue = createNotificationQueue();
  /** @type {Map<number, PendingRequest>} */
  const pendingRequests = new Map();
  let nextRequestId = 1;
  let closed = false;
  let closeRequested = false;
  let stderrTail = "";
  let processError = /** @type {Error | null} */ (null);
  let startupSettled = false;

  /**
   * @param {Error} error
   * @returns {void}
   */
  function failConnection(error) {
    if (!processError) {
      processError = error;
    }
    closed = true;
    queue.end();
    for (const [id, pending] of [...pendingRequests]) {
      pendingRequests.delete(id);
      pending.reject(processError);
    }
  }

  /**
   * @param {unknown} error
   * @returns {Error}
   */
  function createWriteFailure(error) {
    return createAcpConnectionWriteError({
      command: options.command,
      resolvedCommand,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      error,
      pendingRequests: pendingRequestSummaries(pendingRequests),
      ...(cleanStderrTail(stderrTail) ? { stderrTail: cleanStderrTail(stderrTail) } : {}),
    });
  }

  /**
   * @returns {Error}
   */
  function createUnavailableFailure() {
    return processError ?? createAcpConnectionUnavailableError({
      command: options.command,
      resolvedCommand,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      pendingRequests: pendingRequestSummaries(pendingRequests),
      ...(cleanStderrTail(stderrTail) ? { stderrTail: cleanStderrTail(stderrTail) } : {}),
    });
  }

  const startup = new Promise((resolve, reject) => {
    proc.once("spawn", () => {
      startupSettled = true;
      resolve(undefined);
    });
    proc.once("error", (error) => {
      const phase = startupSettled ? "runtime" : "startup";
      processError = createAcpProcessError({
        phase,
        command: options.command,
        resolvedCommand,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        error,
      });
      closed = true;
      queue.end();
      const pendingRequestList = pendingRequestSummaries(pendingRequests);
      for (const [id, pending] of [...pendingRequests]) {
        pendingRequests.delete(id);
        pending.reject(processError);
      }
      if (!closeRequested) {
        log.warn(phase === "startup" ? "ACP child process failed to start." : "ACP child process error.", {
          command: options.command,
          resolvedCommand,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          code: getErrorCode(error),
          message: getErrorMessage(error),
          pendingRequests: pendingRequestList,
        });
      }
      if (phase === "startup") {
        reject(processError);
      }
    });
  });

  proc.stdin.on("error", (error) => {
    const pendingRequestList = pendingRequestSummaries(pendingRequests);
    const writeError = createWriteFailure(error);
    failConnection(writeError);
    if (!closeRequested) {
      log.warn("ACP child stdin failed.", {
        command: options.command,
        resolvedCommand,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        code: getErrorCode(error),
        message: getErrorMessage(error),
        pendingRequests: pendingRequestList,
        ...(cleanStderrTail(stderrTail) ? { stderrTail: cleanStderrTail(stderrTail) } : {}),
      });
    }
    try {
      proc.kill();
    } catch {
      // best-effort cleanup
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    stderrTail = appendStderrTail(stderrTail, String(chunk));
    if (!shouldLogAcpChildStderr()) {
      return;
    }
    const text = String(chunk).trimEnd();
    if (text) {
      log.debug("[acp stderr]", text);
    }
  });

  const rl = readline.createInterface({
    input: proc.stdout,
    crlfDelay: Infinity,
  });

  /**
   * @param {Record<string, unknown>} message
   */
  function send(message) {
    const jsonRpcMessage = { jsonrpc: "2.0", ...message };
    captureAcpProtocolMessage(fixtureCapture, "client_to_agent", jsonRpcMessage);
    if (closed || proc.stdin.destroyed || proc.stdin.writableEnded || !proc.stdin.writable) {
      throw createUnavailableFailure();
    }
    try {
      proc.stdin.write(`${JSON.stringify(jsonRpcMessage)}\n`);
    } catch (error) {
      const writeError = createWriteFailure(error);
      failConnection(writeError);
      throw writeError;
    }
  }

  /**
   * @param {string} message
   * @param {unknown} error
   * @returns {void}
   */
  function logOutboundWriteFailure(message, error) {
    if (closeRequested) {
      return;
    }
    log.warn(message, {
      command: options.command,
      resolvedCommand,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      message: getErrorMessage(error),
    });
  }

  /**
   * @param {Record<string, unknown>} message
   * @param {string} failureMessage
   * @returns {boolean}
   */
  function trySend(message, failureMessage) {
    try {
      send(message);
      return true;
    } catch (error) {
      logOutboundWriteFailure(failureMessage, error);
      return false;
    }
  }

  /**
   * @param {number} id
   * @param {unknown} result
   */
  function resolveRequest(id, result) {
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(id);
    pending.resolve(result);
  }

  /**
   * @param {number} id
   * @param {string} message
   */
  function rejectRequest(id, message) {
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(id);
    pending.reject(new Error(message));
  }

  /**
   * @returns {void}
   */
  function refreshActivityTimeouts() {
    for (const pending of pendingRequests.values()) {
      pending.refreshTimeout?.();
    }
  }

  const readLoop = (async () => {
    try {
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        /** @type {Record<string, unknown>} */
        let message;
        try {
          message = /** @type {Record<string, unknown>} */ (JSON.parse(line));
        } catch (error) {
          log.error("Failed to parse ACP message:", error, line);
          continue;
        }
        refreshActivityTimeouts();
        captureAcpProtocolMessage(fixtureCapture, "agent_to_client", message);

        if (typeof message.id === "number" && !("method" in message)) {
          if ("error" in message) {
            rejectRequest(message.id, jsonRpcErrorMessage(message.error));
          } else {
            resolveRequest(message.id, "result" in message ? message.result : undefined);
          }
          continue;
        }

        if (typeof message.id === "number" && typeof message.method === "string") {
          /** @type {Record<string, unknown>} */
          let response;
          try {
            const result = options.handleRequest ? await options.handleRequest(message) : {};
            response = { id: message.id, result: result ?? {} };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            response = { id: message.id, error: { code: jsonRpcErrorCode(error), message: errorMessage } };
          }
          trySend(response, "ACP client request response send failed.");
          continue;
        }

        queue.push(message);
      }
    } finally {
      queue.end();
    }
  })();

  proc.once("exit", (exitCode, signal) => {
    if (processError) {
      return;
    }
    closed = true;
    queue.end();
    const pendingRequestList = pendingRequestSummaries(pendingRequests);
    const details = {
      command: options.command,
      pid: proc.pid,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      exitCode,
      signal,
      pendingRequests: pendingRequestList,
      ...(cleanStderrTail(stderrTail) ? { stderrTail: cleanStderrTail(stderrTail) } : {}),
    };
    if (!closeRequested && (pendingRequestList.length > 0 || exitCode !== 0 || signal)) {
      log.warn("ACP child process closed unexpectedly.", details);
    }
    const message = formatConnectionClosedMessage({ exitCode, signal, pendingRequests: pendingRequestList });
    for (const [id] of pendingRequests) {
      rejectRequest(id, message);
    }
  });

  await startup;

  return {
    proc,
    sendRequest(method, params = {}, requestOptions = /** @type {{ timeoutMs?: number, refreshOnActivity?: boolean }} */ ({})) {
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        const timeoutMs = typeof requestOptions.timeoutMs === "number" && Number.isFinite(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0
          ? requestOptions.timeoutMs
          : null;
        const clearRequestTimer = () => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        };
        const armRequestTimer = () => {
          if (!timeoutMs) {
            return;
          }
          clearRequestTimer();
          timer = setTimeout(() => {
            const pendingRequestList = pendingRequestSummaries(pendingRequests);
            if (!pendingRequests.delete(id)) {
              return;
            }
            const timeoutDetails = {
              command: options.command,
              pid: proc.pid,
              ...(options.cwd ? { cwd: options.cwd } : {}),
              pendingRequests: pendingRequestList,
              ...(cleanStderrTail(stderrTail) ? { stderrTail: cleanStderrTail(stderrTail) } : {}),
            };
            log.warn("ACP request timed out.", timeoutDetails);
            reject(createRequestTimeoutError(method, timeoutMs, timeoutDetails));
          }, timeoutMs);
          timer.unref?.();
        };
        /** @type {PendingRequest} */
        const pending = {
          method,
          resolve: (value) => {
            clearRequestTimer();
            resolve(value);
          },
          reject: (error) => {
            clearRequestTimer();
            reject(error);
          },
          ...(requestOptions.refreshOnActivity ? { refreshTimeout: armRequestTimer } : {}),
        };
        pendingRequests.set(id, pending);
        armRequestTimer();
        try {
          send({ id, method, params });
        } catch (error) {
          if (pendingRequests.delete(id)) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    },
    sendNotification(method, params = {}) {
      trySend({ method, params }, "ACP notification send failed.");
    },
    notifications: queue.iterate(),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      closeRequested = true;
      try {
        proc.kill();
      } catch {
        // best-effort cleanup
      }
      queue.end();
      await waitForProcessExit(proc, 2_000);
      await readLoop.catch(() => {});
    },
  };
}
