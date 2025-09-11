import { PGlite } from "@electric-sql/pglite";

/** @type {Map<string, PGlite>} */
const dbCache = new Map();

/**
 * @param {string} dataDir
 * @returns PGlite
 */
export function getDb(dataDir) {
  const db = dbCache.get(dataDir);
  if (db) return db;

  const createdDb = new PGlite(dataDir);
  dbCache.set(dataDir, createdDb);
  return createdDb;
}
