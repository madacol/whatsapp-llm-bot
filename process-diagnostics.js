/**
 * @typedef {{
 *   pid: number,
 *   uptimeSeconds: number,
 *   dbCacheSize: number,
 *   dbCachePaths: string[],
 * }} ProcessDiagnosticSnapshot
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
