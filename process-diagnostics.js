const DEFAULT_INTERVAL_MS = 60_000;

/**
 * @typedef {{
 *   pid: number,
 *   uptimeSeconds: number,
 *   dbCacheSize: number,
 *   dbCachePaths: string[],
 * }} ProcessDiagnosticSnapshot
 *
 * @typedef {{
 *   info: (...args: unknown[]) => void,
 *   warn: (...args: unknown[]) => void,
 *   error: (...args: unknown[]) => void,
 * }} DiagnosticLogger
 */

/**
 * @param {ProcessDiagnosticSnapshot} snapshot
 * @returns {string}
 */
export function formatProcessDiagnosticSnapshot(snapshot) {
  const paths = snapshot.dbCachePaths.length > 0
    ? ` paths=${snapshot.dbCachePaths.slice(0, 5).join(",")}${snapshot.dbCachePaths.length > 5 ? ",..." : ""}`
    : "";
  return `pid=${snapshot.pid} uptime=${Math.round(snapshot.uptimeSeconds)}s db_cache_size=${snapshot.dbCacheSize}${paths}`;
}

/**
 * @param {{
 *   dbCacheSize: number,
 *   dbCachePaths: string[],
 *   pid?: number,
 *   uptime?: () => number,
 * }} params
 * @returns {ProcessDiagnosticSnapshot}
 */
export function createProcessDiagnosticSnapshot(params) {
  return {
    pid: params.pid ?? process.pid,
    uptimeSeconds: params.uptime?.() ?? process.uptime(),
    dbCacheSize: params.dbCacheSize,
    dbCachePaths: params.dbCachePaths,
  };
}

/**
 * @param {{
 *   log: DiagnosticLogger,
 *   getDbCacheSize: () => number,
 *   getDbCachePaths: () => string[],
 *   intervalMs?: number,
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
