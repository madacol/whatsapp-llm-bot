import fs from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{
 *   provider: import("./harness-runtime-events.js").HarnessRuntimeProvider,
 *   type: string,
 *   eventId?: string,
 *   createdAt?: string,
 *   providerInstanceId?: string,
 *   raw: Record<string, unknown>,
 * }} HarnessRawEventLogEntry
 */

/**
 * @typedef {{
 *   write: (entry: HarnessRawEventLogEntry) => Promise<void> | void,
 * }} HarnessRawEventLogger
 */

/**
 * @param {string} filePath
 * @returns {HarnessRawEventLogger}
 */
export function createNdjsonRawEventLogger(filePath) {
  return {
    async write(entry) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    },
  };
}

/** @type {{ filePath: string, logger: HarnessRawEventLogger } | null} */
let cachedEnvLogger = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {HarnessRawEventLogger | null}
 */
export function getHarnessRawEventLoggerFromEnv(env = process.env) {
  const rawPath = typeof env.HARNESS_RAW_EVENT_LOG === "string"
    ? env.HARNESS_RAW_EVENT_LOG.trim()
    : "";
  if (!rawPath) {
    return null;
  }
  const filePath = path.resolve(rawPath);
  if (cachedEnvLogger?.filePath === filePath) {
    return cachedEnvLogger.logger;
  }
  cachedEnvLogger = { filePath, logger: createNdjsonRawEventLogger(filePath) };
  return cachedEnvLogger.logger;
}
