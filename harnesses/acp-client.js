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
const ACP_PROTOCOL_LOG_ENV = "HARNESS_ACP_PROTOCOL_LOG";
const ACP_STDERR_TAIL_MAX_CHARS = 4_000;
const ACP_PROTOCOL_LOG_RETENTION_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const HOURLY_PROTOCOL_LOG_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}Z$/;

/**
 * @typedef {{ method: string, resolve: (value: unknown) => void, reject: (error: Error) => void }} PendingRequest
 */

/**
 * @typedef {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   handleRequest?: (message: Record<string, unknown>) => Promise<unknown>,
 *   protocolLogger?: AcpProtocolLogger | null,
 * }} OpenAcpConnectionOptions
 */

/**
 * @typedef {{
 *   timestamp: string,
 *   direction: "client_to_agent" | "agent_to_client",
 *   kind: "request" | "response" | "notification",
 *   id?: string | number,
 *   method?: string,
 *   message: Record<string, unknown>,
 * }} AcpProtocolLogEntry
 */

/**
 * @typedef {{
 *   write: (entry: AcpProtocolLogEntry) => Promise<void> | void,
 * }} AcpProtocolLogger
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
 * @param {string} filePath
 * @param {Date} date
 * @returns {string}
 */
function formatHourlyProtocolLogPath(filePath, date) {
  const parsed = path.parse(filePath);
  const hourStamp = formatUtcHourStamp(date);
  return path.join(parsed.dir, `${parsed.name}.${hourStamp}${parsed.ext}`);
}

/**
 * @param {Date} date
 * @returns {string}
 */
function formatUtcHourStamp(date) {
  return `${date.toISOString().slice(0, 13)}Z`;
}

/**
 * @param {string} value
 * @returns {Date}
 */
function parseProtocolLogEntryTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * @param {Date} date
 * @returns {number}
 */
function utcHourStartMs(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
}

/**
 * @param {string} stamp
 * @returns {number | null}
 */
function parseUtcHourStampMs(stamp) {
  if (!HOURLY_PROTOCOL_LOG_STAMP_PATTERN.test(stamp)) {
    return null;
  }
  const ms = Date.parse(`${stamp.slice(0, 13)}:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {string} baseFilePath
 * @param {string} filename
 * @returns {number | null}
 */
function hourlyProtocolLogFileTimestampMs(baseFilePath, filename) {
  const parsed = path.parse(baseFilePath);
  const prefix = `${parsed.name}.`;
  if (!filename.startsWith(prefix) || !filename.endsWith(parsed.ext)) {
    return null;
  }
  const stamp = filename.slice(prefix.length, filename.length - parsed.ext.length);
  return parseUtcHourStampMs(stamp);
}

/**
 * @param {string} baseFilePath
 * @param {Date} now
 * @returns {Promise<void>}
 */
async function pruneOldHourlyProtocolLogs(baseFilePath, now) {
  const parsed = path.parse(baseFilePath);
  const cutoffMs = utcHourStartMs(now) - ACP_PROTOCOL_LOG_RETENTION_HOURS * HOUR_MS;
  let entries;
  try {
    entries = await fs.promises.readdir(parsed.dir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    const stampMs = hourlyProtocolLogFileTimestampMs(baseFilePath, entry);
    if (stampMs === null || stampMs >= cutoffMs) {
      return;
    }
    try {
      await fs.promises.unlink(path.join(parsed.dir, entry));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }));
}

/**
 * @param {string} filePath
 * @returns {AcpProtocolLogger}
 */
export function createNdjsonAcpProtocolLogger(filePath) {
  const baseFilePath = path.resolve(filePath);
  /** @type {Promise<void>} */
  let pendingWrite = Promise.resolve();
  let activeHourStamp = "";

  /**
   * @param {AcpProtocolLogEntry} entry
   * @returns {Promise<void>}
   */
  async function writeEntry(entry) {
    const entryDate = parseProtocolLogEntryTimestamp(entry.timestamp);
    const hourStamp = formatUtcHourStamp(entryDate);
    const targetPath = formatHourlyProtocolLogPath(baseFilePath, entryDate);
    if (hourStamp !== activeHourStamp) {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await pruneOldHourlyProtocolLogs(baseFilePath, entryDate);
      } catch (error) {
        log.warn("Failed to prune old ACP protocol logs.", error);
      }
      activeHourStamp = hourStamp;
    }
    await fs.promises.appendFile(targetPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  return {
    write(entry) {
      const write = pendingWrite.then(() => writeEntry(entry), () => writeEntry(entry));
      pendingWrite = write.catch(() => {});
      return write;
    },
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AcpProtocolLogger | null}
 */
function getAcpProtocolLoggerFromEnv(env = process.env) {
  const rawPath = typeof env[ACP_PROTOCOL_LOG_ENV] === "string"
    ? env[ACP_PROTOCOL_LOG_ENV].trim()
    : "";
  return rawPath ? createNdjsonAcpProtocolLogger(path.resolve(rawPath)) : null;
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
 * @param {AcpProtocolLogger | null} protocolLogger
 * @param {"client_to_agent" | "agent_to_client"} direction
 * @param {Record<string, unknown>} message
 * @returns {void}
 */
function logAcpProtocolMessage(protocolLogger, direction, message) {
  if (!protocolLogger) {
    return;
  }
  const entry = {
    timestamp: new Date().toISOString(),
    direction,
    kind: classifyAcpProtocolMessage(message),
    ...(message.id !== undefined && (typeof message.id === "string" || typeof message.id === "number") ? { id: message.id } : {}),
    ...(typeof message.method === "string" ? { method: message.method } : {}),
    message,
  };
  Promise.resolve(protocolLogger.write(entry)).catch((error) => {
    log.warn("Failed to write ACP protocol log entry.", error);
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
  const protocolLogger = options.protocolLogger ?? getAcpProtocolLoggerFromEnv(options.env ?? process.env);
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
    logAcpProtocolMessage(protocolLogger, "client_to_agent", jsonRpcMessage);
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
        logAcpProtocolMessage(protocolLogger, "agent_to_client", message);

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
    sendRequest(method, params = {}) {
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { method, resolve, reject });
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
