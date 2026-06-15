import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname);
const DEFAULT_RELOAD_INTERVAL_MS = 1_000;

export const ACP_PROTOCOL_LOG_ENV = "MADABOT_ACP_PROTOCOL_LOG";
export const ACP_STDERR_LOG_ENV = "MADABOT_ACP_STDERR_LOG";
export const RAW_EVENT_LOG_ENV = "MADABOT_RAW_EVENT_LOG";
export const DB_CACHE_LOG_ENV = "DB_DIAGNOSTICS";
export const LOG_LEVEL_ENV = "LOG_LEVEL";
export const RUNTIME_DIAGNOSTICS_CONFIG_PATH = path.join(REPO_ROOT, ".diagnostics", "logging.json");
const LEGACY_WHATSAPP_DIAGNOSTIC_ENABLE_PATH = path.join(REPO_ROOT, "logs", "whatsapp-upsert-shape.enabled");
const LOG_LEVEL_VALUES = new Set(["debug", "info", "warn", "error", "silent"]);

/**
 * @typedef {{
 *   acpProtocolLog: boolean,
 *   acpStderrLog: boolean,
 *   rawEventLog: boolean,
 *   dbCacheLog: boolean,
 *   whatsappUpsertLog: boolean,
 *   whatsappReactionLog: boolean,
 *   whatsappOutboundLog: boolean,
 *   logLevel: "debug" | "info" | "warn" | "error" | "silent" | null,
 * }} RuntimeDiagnosticsConfig
 */

/**
 * @typedef {{
 *   getConfig: () => RuntimeDiagnosticsConfig,
 *   isAcpProtocolLogEnabled: () => boolean,
 *   isAcpStderrLogEnabled: () => boolean,
 *   isRawEventLogEnabled: () => boolean,
 *   isDbCacheLogEnabled: () => boolean,
 *   isWhatsAppUpsertLogEnabled: () => boolean,
 *   isWhatsAppReactionLogEnabled: () => boolean,
 *   isWhatsAppOutboundLogEnabled: () => boolean,
 *   update: (patch: Partial<RuntimeDiagnosticsConfig>) => Promise<RuntimeDiagnosticsConfig>,
 * }} RuntimeDiagnosticsState
 */

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {boolean} legacyWhatsAppDiagnosticEnabled
 * @returns {RuntimeDiagnosticsConfig}
 */
function readEnvDefaults(env, legacyWhatsAppDiagnosticEnabled) {
  return {
    acpProtocolLog: env[ACP_PROTOCOL_LOG_ENV] === "1",
    acpStderrLog: env[ACP_STDERR_LOG_ENV] === "1",
    rawEventLog: env[RAW_EVENT_LOG_ENV] === "1",
    dbCacheLog: env[DB_CACHE_LOG_ENV] === "1",
    whatsappUpsertLog: legacyWhatsAppDiagnosticEnabled,
    whatsappReactionLog: legacyWhatsAppDiagnosticEnabled,
    whatsappOutboundLog: false,
    logLevel: normalizeLogLevel(env[LOG_LEVEL_ENV]),
  };
}

/**
 * @param {unknown} value
 * @returns {RuntimeDiagnosticsConfig["logLevel"]}
 */
function normalizeLogLevel(value) {
  if (typeof value !== "string") {
    return null;
  }
  return LOG_LEVEL_VALUES.has(value) ? /** @type {RuntimeDiagnosticsConfig["logLevel"]} */ (value) : null;
}

/**
 * @param {unknown} raw
 * @param {RuntimeDiagnosticsConfig} fallback
 * @returns {RuntimeDiagnosticsConfig}
 */
function normalizeRuntimeDiagnosticsConfig(raw, fallback) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    acpProtocolLog: typeof record.acpProtocolLog === "boolean" ? record.acpProtocolLog : fallback.acpProtocolLog,
    acpStderrLog: typeof record.acpStderrLog === "boolean" ? record.acpStderrLog : fallback.acpStderrLog,
    rawEventLog: typeof record.rawEventLog === "boolean" ? record.rawEventLog : fallback.rawEventLog,
    dbCacheLog: typeof record.dbCacheLog === "boolean" ? record.dbCacheLog : fallback.dbCacheLog,
    whatsappUpsertLog: typeof record.whatsappUpsertLog === "boolean" ? record.whatsappUpsertLog : fallback.whatsappUpsertLog,
    whatsappReactionLog: typeof record.whatsappReactionLog === "boolean" ? record.whatsappReactionLog : fallback.whatsappReactionLog,
    whatsappOutboundLog: typeof record.whatsappOutboundLog === "boolean" ? record.whatsappOutboundLog : fallback.whatsappOutboundLog,
    logLevel: "logLevel" in record ? normalizeLogLevel(record.logLevel) : fallback.logLevel,
  };
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function hasErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/**
 * @param {{
 *   configPath?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   legacyWhatsAppDiagnosticEnabled?: boolean,
 *   reloadIntervalMs?: number,
 * }} [options]
 * @returns {RuntimeDiagnosticsState}
 */
export function createRuntimeDiagnosticsState(options = {}) {
  const configPath = options.configPath ?? RUNTIME_DIAGNOSTICS_CONFIG_PATH;
  const env = options.env ?? process.env;
  const getLegacyWhatsAppDiagnosticEnabled = () => options.legacyWhatsAppDiagnosticEnabled
    ?? fs.existsSync(LEGACY_WHATSAPP_DIAGNOSTIC_ENABLE_PATH);
  const reloadIntervalMs = options.reloadIntervalMs ?? DEFAULT_RELOAD_INTERVAL_MS;
  /** @type {RuntimeDiagnosticsConfig | null} */
  let cachedConfig = null;
  let lastCheckMs = 0;
  let lastFileSignature = "";

  /**
   * @returns {RuntimeDiagnosticsConfig}
   */
  function readConfig() {
    const now = Date.now();
    const fallback = readEnvDefaults(env, getLegacyWhatsAppDiagnosticEnabled());
    let stat;
    try {
      stat = fs.statSync(configPath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        return cachedConfig ?? fallback;
      }
      lastFileSignature = "missing";
      cachedConfig = fallback;
      return cachedConfig;
    }

    if (cachedConfig && reloadIntervalMs > 0 && now - lastCheckMs < reloadIntervalMs) {
      return cachedConfig;
    }
    lastCheckMs = now;
    const fileSignature = `${stat.mtimeMs}:${stat.size}`;
    if (cachedConfig && fileSignature === lastFileSignature) {
      return cachedConfig;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      cachedConfig = normalizeRuntimeDiagnosticsConfig(raw, fallback);
      lastFileSignature = fileSignature;
      return cachedConfig;
    } catch {
      return cachedConfig ?? fallback;
    }
  }

  return {
    getConfig() {
      return readConfig();
    },
    isAcpProtocolLogEnabled() {
      return readConfig().acpProtocolLog;
    },
    isAcpStderrLogEnabled() {
      return readConfig().acpStderrLog;
    },
    isRawEventLogEnabled() {
      return readConfig().rawEventLog;
    },
    isDbCacheLogEnabled() {
      return readConfig().dbCacheLog;
    },
    isWhatsAppUpsertLogEnabled() {
      return readConfig().whatsappUpsertLog;
    },
    isWhatsAppReactionLogEnabled() {
      return readConfig().whatsappReactionLog;
    },
    isWhatsAppOutboundLogEnabled() {
      return readConfig().whatsappOutboundLog;
    },
    async update(patch) {
      const current = readConfig();
      const next = normalizeRuntimeDiagnosticsConfig({ ...current, ...patch }, current);
      await mkdir(path.dirname(configPath), { recursive: true });
      const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tempPath, configPath);
      cachedConfig = next;
      lastCheckMs = Date.now();
      try {
        const stat = fs.statSync(configPath);
        lastFileSignature = `${stat.mtimeMs}:${stat.size}`;
      } catch {
        lastFileSignature = "";
      }
      return next;
    },
  };
}

/** @type {RuntimeDiagnosticsState | null} */
let defaultRuntimeDiagnosticsState = null;

/**
 * @returns {RuntimeDiagnosticsState}
 */
export function getDefaultRuntimeDiagnosticsState() {
  if (!defaultRuntimeDiagnosticsState) {
    defaultRuntimeDiagnosticsState = createRuntimeDiagnosticsState();
  }
  return defaultRuntimeDiagnosticsState;
}

/**
 * @param {RuntimeDiagnosticsState | null} state
 * @returns {void}
 */
export function setDefaultRuntimeDiagnosticsStateForTesting(state) {
  defaultRuntimeDiagnosticsState = state;
}
