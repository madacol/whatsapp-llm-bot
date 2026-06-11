import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultRuntimeDiagnosticsState } from "../diagnostics-config.js";
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

/**
 * @param {string} filePath
 * @param {import("../diagnostics-config.js").RuntimeDiagnosticsState} [diagnosticsState]
 * @returns {HarnessRawEventLogger}
 */
export function createRuntimeGatedRawEventLogger(filePath, diagnosticsState = getDefaultRuntimeDiagnosticsState()) {
  /** @type {HarnessRawEventLogger | null} */
  let logger = null;
  return {
    write(entry) {
      if (!diagnosticsState.isRawEventLogEnabled()) {
        return;
      }
      if (!logger) {
        logger = createNdjsonRawEventLogger(filePath);
      }
      return logger.write(entry);
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
    cachedDefaultLogger = createRuntimeGatedRawEventLogger(RAW_EVENT_LOG_BASE_PATH);
  }
  return cachedDefaultLogger;
}
