import fs from "node:fs";

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * @returns {string}
 */
function getDefaultCgroupMemoryEventsPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid == null
    ? "/sys/fs/cgroup/memory.events"
    : `/sys/fs/cgroup/user.slice/user-${uid}.slice/memory.events`;
}

/**
 * @typedef {{
 *   pid: number,
 *   uptimeSeconds: number,
 *   dbCacheSize: number,
 *   dbCachePaths: string[],
 *   cgroupMemoryEvents: Record<string, number> | null,
 * }} ProcessDiagnosticSnapshot
 *
 * @typedef {{
 *   info: (...args: unknown[]) => void,
 *   warn: (...args: unknown[]) => void,
 *   error: (...args: unknown[]) => void,
 * }} DiagnosticLogger
 */

/**
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function parseCgroupMemoryEvents(text) {
  /** @type {Record<string, number>} */
  const events = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, rawValue] = trimmed.split(/\s+/, 2);
    const value = Number(rawValue);
    if (key && Number.isFinite(value)) {
      events[key] = value;
    }
  }
  return events;
}

/**
 * @param {ProcessDiagnosticSnapshot} snapshot
 * @returns {string}
 */
export function formatProcessDiagnosticSnapshot(snapshot) {
  const oomKills = snapshot.cgroupMemoryEvents?.oom_kill;
  const paths = snapshot.dbCachePaths.length > 0
    ? ` paths=${snapshot.dbCachePaths.slice(0, 5).join(",")}${snapshot.dbCachePaths.length > 5 ? ",..." : ""}`
    : "";
  const oom = oomKills === undefined ? "" : ` cgroup_oom_kill=${oomKills}`;
  return `pid=${snapshot.pid} uptime=${Math.round(snapshot.uptimeSeconds)}s db_cache_size=${snapshot.dbCacheSize}${oom}${paths}`;
}

/**
 * @param {{
 *   dbCacheSize: number,
 *   dbCachePaths: string[],
 *   cgroupMemoryEventsPath?: string,
 *   readFileSync?: (path: string, encoding: BufferEncoding) => string,
 *   pid?: number,
 *   uptime?: () => number,
 * }} params
 * @returns {ProcessDiagnosticSnapshot}
 */
export function createProcessDiagnosticSnapshot(params) {
  const readFileSync = params.readFileSync ?? fs.readFileSync;
  const cgroupMemoryEventsPath = params.cgroupMemoryEventsPath ?? getDefaultCgroupMemoryEventsPath();
  /** @type {Record<string, number> | null} */
  let cgroupMemoryEvents = null;
  try {
    cgroupMemoryEvents = parseCgroupMemoryEvents(readFileSync(cgroupMemoryEventsPath, "utf8"));
  } catch {
    cgroupMemoryEvents = null;
  }

  return {
    pid: params.pid ?? process.pid,
    uptimeSeconds: params.uptime?.() ?? process.uptime(),
    dbCacheSize: params.dbCacheSize,
    dbCachePaths: params.dbCachePaths,
    cgroupMemoryEvents,
  };
}

/**
 * @param {{
 *   log: DiagnosticLogger,
 *   getDbCacheSize: () => number,
 *   getDbCachePaths: () => string[],
 *   intervalMs?: number,
 *   cgroupMemoryEventsPath?: string,
 * }} params
 * @returns {() => void}
 */
export function startProcessDiagnostics(params) {
  const envIntervalMs = Number(process.env.PROCESS_DIAGNOSTICS_INTERVAL_MS);
  const intervalMs = params.intervalMs ?? (Number.isFinite(envIntervalMs) && envIntervalMs > 0 ? envIntervalMs : DEFAULT_INTERVAL_MS);
  const logSnapshot = () => {
    const snapshot = createProcessDiagnosticSnapshot({
      dbCacheSize: params.getDbCacheSize(),
      dbCachePaths: params.getDbCachePaths(),
      cgroupMemoryEventsPath: params.cgroupMemoryEventsPath,
    });
    params.log.info("process diagnostics:", formatProcessDiagnosticSnapshot(snapshot));
  };

  logSnapshot();
  const timer = setInterval(logSnapshot, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    logSnapshot();
  };
}
