import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname);
const DEFAULT_RELOAD_INTERVAL_MS = 1_000;

export const ACP_STDERR_LOG_ENV = "MADABOT_ACP_STDERR_LOG";
export const DB_CACHE_LOG_ENV = "DB_DIAGNOSTICS";
export const LOG_LEVEL_ENV = "LOG_LEVEL";
export const RUNTIME_DIAGNOSTICS_CONFIG_PATH = path.join(REPO_ROOT, ".diagnostics", "logging.json");
const LOG_LEVEL_VALUES = new Set(["debug", "info", "warn", "error", "silent"]);

/**
 * @typedef {{
 *   enabledUntil?: string,
 *   rotateMinutes?: number,
 *   retentionHours?: number,
 *   queueLimit?: number,
 *   fullRawUntil?: string,
 *   fieldPolicies?: Record<string, {
 *     capBytes?: number,
 *     fullRawUntil?: string,
 *   }>,
 * }} CaptureSeamConfig
 *
 * @typedef {{
 *   seams: Record<string, CaptureSeamConfig>,
 * }} CaptureConfig
 *
 * @typedef {{
 *   capture: CaptureConfig,
 *   logLevel: "debug" | "info" | "warn" | "error" | "silent" | null,
 * }} RuntimeDiagnosticsConfig
 */

/**
 * @typedef {{
 *   getConfig: () => RuntimeDiagnosticsConfig,
 *   isAcpStderrLogEnabled: () => boolean,
 *   isDbCacheLogEnabled: () => boolean,
 *   update: (patch: Partial<RuntimeDiagnosticsConfig>) => Promise<RuntimeDiagnosticsConfig>,
 * }} RuntimeDiagnosticsState
 */

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {RuntimeDiagnosticsConfig}
 */
function readEnvDefaults(env) {
  return {
    capture: { seams: {} },
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
    capture: normalizeCaptureConfig(record.capture, fallback.capture),
    logLevel: "logLevel" in record ? normalizeLogLevel(record.logLevel) : fallback.logLevel,
  };
}

/**
 * @param {unknown} raw
 * @param {CaptureConfig} fallback
 * @returns {CaptureConfig}
 */
function normalizeCaptureConfig(raw, fallback) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const rawSeams = record.seams && typeof record.seams === "object" && !Array.isArray(record.seams)
    ? /** @type {Record<string, unknown>} */ (record.seams)
    : {};
  /** @type {Record<string, CaptureSeamConfig>} */
  const seams = { ...fallback.seams };
  for (const [seam, value] of Object.entries(rawSeams)) {
    seams[seam] = normalizeCaptureSeamConfig(value, fallback.seams[seam] ?? {});
  }
  return { seams };
}

/**
 * @param {unknown} raw
 * @param {CaptureSeamConfig} fallback
 * @returns {CaptureSeamConfig}
 */
function normalizeCaptureSeamConfig(raw, fallback) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    ...(typeof record.enabledUntil === "string" ? { enabledUntil: record.enabledUntil } : pickString(fallback, "enabledUntil")),
    ...(typeof record.rotateMinutes === "number" && Number.isFinite(record.rotateMinutes) && record.rotateMinutes > 0 ? { rotateMinutes: record.rotateMinutes } : pickNumber(fallback, "rotateMinutes")),
    ...(typeof record.retentionHours === "number" && Number.isFinite(record.retentionHours) && record.retentionHours >= 0 ? { retentionHours: record.retentionHours } : pickNumber(fallback, "retentionHours")),
    ...(typeof record.queueLimit === "number" && Number.isFinite(record.queueLimit) && record.queueLimit >= 0 ? { queueLimit: Math.floor(record.queueLimit) } : pickNumber(fallback, "queueLimit")),
    ...(typeof record.fullRawUntil === "string" ? { fullRawUntil: record.fullRawUntil } : pickString(fallback, "fullRawUntil")),
    fieldPolicies: normalizeFieldPolicies(record.fieldPolicies, fallback.fieldPolicies ?? {}),
  };
}

/**
 * @param {CaptureSeamConfig} value
 * @param {"enabledUntil" | "fullRawUntil"} key
 * @returns {Partial<CaptureSeamConfig>}
 */
function pickString(value, key) {
  return typeof value[key] === "string" ? { [key]: value[key] } : {};
}

/**
 * @param {CaptureSeamConfig} value
 * @param {"rotateMinutes" | "retentionHours" | "queueLimit"} key
 * @returns {Partial<CaptureSeamConfig>}
 */
function pickNumber(value, key) {
  return typeof value[key] === "number" ? { [key]: value[key] } : {};
}

/**
 * @param {unknown} raw
 * @param {NonNullable<CaptureSeamConfig["fieldPolicies"]>} fallback
 * @returns {NonNullable<CaptureSeamConfig["fieldPolicies"]>}
 */
function normalizeFieldPolicies(raw, fallback) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  /** @type {NonNullable<CaptureSeamConfig["fieldPolicies"]>} */
  const policies = { ...fallback };
  for (const [group, value] of Object.entries(record)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const policy = /** @type {Record<string, unknown>} */ (value);
    policies[group] = {
      ...(typeof policy.capBytes === "number" && Number.isFinite(policy.capBytes) && policy.capBytes >= 0 ? { capBytes: Math.floor(policy.capBytes) } : {}),
      ...(typeof policy.fullRawUntil === "string" ? { fullRawUntil: policy.fullRawUntil } : {}),
    };
  }
  return policies;
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
 *   reloadIntervalMs?: number,
 * }} [options]
 * @returns {RuntimeDiagnosticsState}
 */
export function createRuntimeDiagnosticsState(options = {}) {
  const configPath = options.configPath ?? RUNTIME_DIAGNOSTICS_CONFIG_PATH;
  const env = options.env ?? process.env;
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
    const fallback = readEnvDefaults(env);
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
    isAcpStderrLogEnabled() {
      return env[ACP_STDERR_LOG_ENV] === "1";
    },
    isDbCacheLogEnabled() {
      return env[DB_CACHE_LOG_ENV] === "1";
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
