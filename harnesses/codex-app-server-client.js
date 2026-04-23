import { spawn } from "node:child_process";
import readline from "node:readline";
import { createLogger } from "../logger.js";

const log = createLogger("harness:codex-app-server");

/**
 * @typedef {{ resolve: (value: unknown) => void, reject: (error: Error) => void }} PendingRequest
 */

/**
 * @typedef {{
 *   proc: import("node:child_process").ChildProcessWithoutNullStreams,
 *   sendNotification: (method: string, params?: Record<string, unknown>) => void,
 *   sendRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
 *   notifications: AsyncGenerator<Record<string, unknown>>,
 *   close: () => Promise<void>,
 * }} AppServerConnection
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
        const waiter = waiters.shift();
        waiter?.(null);
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
 * @param {{
 *   codexPath?: string,
 *   handleRequest?: (message: Record<string, unknown>) => Promise<unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<AppServerConnection>}
 */
export async function openCodexAppServerConnection(options = {}) {
  const proc = spawn(options.codexPath ?? "codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal && { signal: options.signal }),
  });

  const queue = createNotificationQueue();
  /** @type {Map<number, PendingRequest>} */
  const pendingRequests = new Map();
  let nextRequestId = 1;
  let closed = false;

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    log.debug("[app-server stderr]", String(chunk).trimEnd());
  });

  const rl = readline.createInterface({
    input: proc.stdout,
    crlfDelay: Infinity,
  });

  /**
   * @param {Record<string, unknown>} message
   * @returns {void}
   */
  const send = (message) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  /**
   * @param {number} id
   * @param {unknown} result
   * @returns {void}
   */
  const resolveRequest = (id, result) => {
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(id);
    pending.resolve(result);
  };

  /**
   * @param {number} id
   * @param {string} message
   * @returns {void}
   */
  const rejectRequest = (id, message) => {
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(id);
    pending.reject(new Error(message));
  };

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
          log.error("Failed to parse Codex app-server message:", error, line);
          continue;
        }

        if (typeof message.id === "number" && !("method" in message)) {
          if (message.error && typeof message.error === "object" && message.error !== null && typeof /** @type {Record<string, unknown>} */ (message.error).message === "string") {
            rejectRequest(message.id, /** @type {Record<string, unknown>} */ (message.error).message);
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
            send({ id: message.id, error: { code: -32000, message: errorMessage } });
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
      rejectRequest(id, "Codex app-server connection closed.");
    }
  });

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<unknown>}
   */
  const sendRequest = (method, params = {}) => {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      send({ method, id, params });
    });
  };

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {void}
   */
  const sendNotification = (method, params = {}) => {
    send({ method, params });
  };

  await sendRequest("initialize", {
    clientInfo: {
      name: "madabot",
      title: "Madabot",
      version: "1.0.0",
    },
    capabilities: {
      optOutNotificationMethods: [
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
        "item/fileChange/outputDelta",
      ],
    },
  });
  sendNotification("initialized", {});

  return {
    proc,
    sendNotification,
    sendRequest,
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
      await readLoop.catch(() => {});
    },
  };
}
