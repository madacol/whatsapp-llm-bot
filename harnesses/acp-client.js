import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import { getDefaultRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { getDefaultFixtureCapture } from "../diagnostics/capture.js";
import { createAcpConnectionFailureLifecycle } from "./acp-client-connection-lifecycle.js";

const log = createLogger("harness:acp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const requireFromHere = createRequire(import.meta.url);
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
  let nextRequestId = 1;
  let startupSettled = false;
  const lifecycle = createAcpConnectionFailureLifecycle({
    command: options.command,
    resolvedCommand,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    getPid: () => proc.pid,
    endNotifications: queue.end,
    kill: () => {
      try {
        proc.kill();
      } catch {
        // best-effort cleanup
      }
    },
    logger: log,
  });

  const startup = new Promise((resolve, reject) => {
    proc.once("spawn", () => {
      startupSettled = true;
      resolve(undefined);
    });
    proc.once("error", (error) => {
      const phase = startupSettled ? "runtime" : "startup";
      const processError = lifecycle.handleProcessError({
        phase,
        error,
      });
      if (phase === "startup") {
        reject(processError);
      }
    });
  });

  proc.stdin.on("error", (error) => {
    lifecycle.handleStdinError(error);
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    lifecycle.appendStderr(String(chunk));
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
    if (lifecycle.isClosed() || proc.stdin.destroyed || proc.stdin.writableEnded || !proc.stdin.writable) {
      throw lifecycle.createUnavailableFailure();
    }
    try {
      proc.stdin.write(`${JSON.stringify(jsonRpcMessage)}\n`);
    } catch (error) {
      throw lifecycle.failWrite(error);
    }
  }

  /**
   * @param {string} message
   * @param {unknown} error
   * @returns {void}
   */
  function logOutboundWriteFailure(message, error) {
    if (lifecycle.isCloseRequested()) {
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
    lifecycle.resolveRequest(id, result);
  }

  /**
   * @param {number} id
   * @param {string} message
   */
  function rejectRequest(id, message) {
    lifecycle.rejectRequest(id, message);
  }

  /**
   * @returns {void}
   */
  function refreshActivityTimeouts() {
    lifecycle.refreshActivityTimeouts();
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
    lifecycle.handleExit({ exitCode, signal });
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
            lifecycle.timeoutRequest(id, method, timeoutMs);
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
        lifecycle.addPendingRequest(id, pending);
        armRequestTimer();
        try {
          send({ id, method, params });
        } catch (error) {
          if (lifecycle.deletePendingRequest(id)) {
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
      if (!lifecycle.beginClose()) {
        return;
      }
      try {
        proc.kill();
      } catch {
        // best-effort cleanup
      }
      await waitForProcessExit(proc, 2_000);
      await readLoop.catch(() => {});
    },
  };
}
