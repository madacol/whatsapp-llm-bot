import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("harness:acp");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ACP_STDERR_LOG_ENV = "MADABOT_ACP_STDERR_LOG";

/**
 * @typedef {{ resolve: (value: unknown) => void, reject: (error: Error) => void }} PendingRequest
 */

/**
 * @typedef {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   handleRequest?: (message: Record<string, unknown>) => Promise<unknown>,
 * }} OpenAcpConnectionOptions
 */

/**
 * @typedef {{
 *   proc: import("node:child_process").ChildProcessWithoutNullStreams,
 *   sendRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function shouldLogAcpChildStderr(env = process.env) {
  return env[ACP_STDERR_LOG_ENV] === "1";
}

/**
 * @param {OpenAcpConnectionOptions} options
 * @returns {Promise<AcpConnection>}
 */
export async function openAcpConnection(options) {
  const proc = spawn(resolveAcpCommandPath(options.command), options.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const queue = createNotificationQueue();
  /** @type {Map<number, PendingRequest>} */
  const pendingRequests = new Map();
  let nextRequestId = 1;
  let closed = false;

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
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
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
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

  proc.once("exit", () => {
    closed = true;
    queue.end();
    for (const [id] of pendingRequests) {
      rejectRequest(id, "ACP connection closed.");
    }
  });

  return {
    proc,
    sendRequest(method, params = {}) {
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
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
