/**
 * @param {string} value
 * @returns {string}
 */
function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isRuntimeStateSnapshotPath(filePath) {
  const normalized = normalizeSlashes(filePath);
  return normalized.includes("/auth_info_baileys/")
    || normalized.startsWith("auth_info_baileys/")
    || normalized.includes("/pgdata/")
    || normalized.startsWith("pgdata/")
    || normalized.includes("/.media/")
    || normalized.startsWith(".media/")
    || normalized.endsWith("/data/models.json")
    || normalized === "data/models.json";
}
