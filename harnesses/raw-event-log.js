import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHourlyNdjsonLogWriter } from "../hourly-ndjson-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_EVENT_LOG_BASE_PATH = path.join(REPO_ROOT, "logs", "raw-events.ndjson");

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
  const writer = createHourlyNdjsonLogWriter(filePath);
  return {
    write(entry) {
      return writer.write(entry);
    },
  };
}

/** @type {HarnessRawEventLogger | null} */
let cachedDefaultLogger = null;

/**
 * @returns {HarnessRawEventLogger}
 */
export function getHarnessRawEventLogger() {
  if (!cachedDefaultLogger) {
    cachedDefaultLogger = createNdjsonRawEventLogger(RAW_EVENT_LOG_BASE_PATH);
  }
  return cachedDefaultLogger;
}
