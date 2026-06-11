import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname);
const DEFAULT_RELOAD_INTERVAL_MS = 1_000;

export const ACP_PROTOCOL_LOG_ENV = "MADABOT_ACP_PROTOCOL_LOG";
export const RAW_EVENT_LOG_ENV = "MADABOT_RAW_EVENT_LOG";
export const RUNTIME_DIAGNOSTICS_CONFIG_PATH = path.join(REPO_ROOT, ".diagnostics", "logging.json");

/**
 * @typedef {{
 *   acpProtocolLog: boolean,
 *   rawEventLog: boolean,
 * }} RuntimeDiagnosticsConfig
 */

/**
 * @typedef {{
 *   getConfig: () => RuntimeDiagnosticsConfig,
 *   isAcpProtocolLogEnabled: () => boolean,
 *   isRawEventLogEnabled: () => boolean,
 *   update: (patch: Partial<RuntimeDiagnosticsConfig>) => Promise<RuntimeDiagnosticsConfig>,
 * }} RuntimeDiagnosticsState
 */

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {RuntimeDiagnosticsConfig}
 */
function readEnvDefaults(env) {
  return {
    acpProtocolLog: env[ACP_PROTOCOL_LOG_ENV] === "1",
    rawEventLog: env[RAW_EVENT_LOG_ENV] === "1",
  };
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
    rawEventLog: typeof record.rawEventLog === "boolean" ? record.rawEventLog : fallback.rawEventLog,
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
    if (cachedConfig && reloadIntervalMs > 0 && now - lastCheckMs < reloadIntervalMs) {
      return cachedConfig;
    }
    lastCheckMs = now;
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
    isRawEventLogEnabled() {
      return readConfig().rawEventLog;
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
