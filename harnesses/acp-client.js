import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import { getDefaultRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { getDefaultFixtureCapture } from "../diagnostics/capture.js";

const log = createLogger("harness:acp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ACP_STDERR_TAIL_MAX_CHARS = 4_000;

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
 * @param {string} command
 * @returns {string}
 */
function resolveAcpCommandPath(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }
  const binName = process.platform === "win32" ? `${command}.cmd` : command;
  const localBin = path.join(REPO_ROOT, "node_modules", ".bin", binName);
  return fs.existsSync(localBin) ? localBin : command;
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
  const proc = spawn(resolveAcpCommandPath(options.command), options.args ?? [], {
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
    proc.stdin.write(`${JSON.stringify(jsonRpcMessage)}\n`);
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
          try {
            const result = options.handleRequest ? await options.handleRequest(message) : {};
            send({ id: message.id, result: result ?? {} });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            send({ id: message.id, error: { code: jsonRpcErrorCode(error), message: errorMessage } });
          }
          continue;
        }

        queue.push(message);
      }
    } finally {
      queue.end();
    }
  })();

  proc.once("exit", (exitCode, signal) => {
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
        pendingRequests.set(id, {
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
        });
        armRequestTimer();
        send({ id, method, params });
      });
    },
    sendNotification(method, params = {}) {
      send({ method, params });
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
