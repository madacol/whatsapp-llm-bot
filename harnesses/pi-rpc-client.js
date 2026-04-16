import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("harness:pi-rpc");

/**
 * @typedef {{ resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void }} PendingRequest
 */

/**
 * @typedef {{
 *   proc: import("node:child_process").ChildProcessWithoutNullStreams,
 *   sendRequest: (message: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   notifications: AsyncGenerator<Record<string, unknown>>,
 *   close: () => Promise<void>,
 * }} PiRpcConnection
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
        return;
      }
      values.push(value);
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
        const nextValue = await new Promise((resolve) => {
          waiters.push(resolve);
        });
        if (!nextValue) {
          return;
        }
        yield nextValue;
      }
    },
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} message
 * @returns {message is Record<string, unknown> & { type: "response", id: string | number }}
 */
function isResponseMessage(message) {
  return message.type === "response" && (typeof message.id === "string" || typeof message.id === "number");
}

/**
 * @returns {string}
 */
function resolvePiExecutable() {
  if (typeof process.env.PI_BIN === "string" && process.env.PI_BIN.trim()) {
    return process.env.PI_BIN.trim();
  }
  const localPiPath = path.resolve(process.cwd(), "node_modules/.bin/pi");
  if (existsSync(localPiPath)) {
    return localPiPath;
  }
  return "pi";
}

/**
 * @param {{
 *   piPath?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<PiRpcConnection>}
 */
export async function openPiRpcConnection(options = {}) {
  const proc = spawn(options.piPath ?? resolvePiExecutable(), ["--mode", "rpc"], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const queue = createNotificationQueue();
  /** @type {Map<string, PendingRequest>} */
  const pendingRequests = new Map();
  let stdoutBuffer = "";
  let closed = false;

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    log.debug("[pi stderr]", String(chunk).trimEnd());
  });

  /**
   * @param {string} requestId
   * @param {Error} error
   * @returns {void}
   */
  const rejectRequest = (requestId, error) => {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    pendingRequests.delete(requestId);
    pending.reject(error);
  };

  /**
   * @param {string} requestId
   * @param {Record<string, unknown>} value
   * @returns {void}
   */
  const resolveRequest = (requestId, value) => {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    pendingRequests.delete(requestId);
    pending.resolve(value);
  };

  /**
   * @param {string} line
   * @returns {void}
   */
  const handleLine = (line) => {
    const trimmedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmedLine.trim()) {
      return;
    }

    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(trimmedLine);
    } catch (error) {
      log.error("Failed to parse Pi RPC message:", error, trimmedLine);
      return;
    }

    if (!isObjectRecord(parsed)) {
      return;
    }

    if (isResponseMessage(parsed)) {
      resolveRequest(String(parsed.id), parsed);
      return;
    }

    queue.push(parsed);
  };

  proc.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  });

  /**
   * @param {string} message
   * @returns {void}
   */
  const closePendingRequests = (message) => {
    for (const requestId of pendingRequests.keys()) {
      rejectRequest(requestId, new Error(message));
    }
  };

  proc.once("error", (error) => {
    closed = true;
    queue.end();
    closePendingRequests(error instanceof Error ? error.message : String(error));
  });

  proc.once("exit", () => {
    closed = true;
    if (stdoutBuffer.length > 0) {
      handleLine(stdoutBuffer);
      stdoutBuffer = "";
    }
    queue.end();
    closePendingRequests("Pi RPC connection closed.");
  });

  return {
    proc,
    sendRequest(message) {
      const requestId = typeof message.id === "string" || typeof message.id === "number"
        ? String(message.id)
        : null;
      if (!requestId) {
        return Promise.reject(new Error("Pi RPC requests require an id."));
      }
      if (closed) {
        return Promise.reject(new Error("Pi RPC connection is closed."));
      }
      return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });
        proc.stdin.write(`${JSON.stringify(message)}\n`);
      });
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
      closePendingRequests("Pi RPC connection closed.");
    },
  };
}
