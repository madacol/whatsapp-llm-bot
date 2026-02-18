import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";

/** @type {Map<string, PGlite>} */
const dbCache = new Map();

/**
 * @param {string} dataDir
 * @param {PGlite} instance
 */
export function setDb(dataDir, instance) {
  dbCache.set(dataDir, instance);
}

/**
 * @param {string} dataDir
 * @returns {PGlite}
 */
export function getDb(dataDir) {
  const db = dbCache.get(dataDir);
  if (db) return db;

  // Ensure parent directories exist for file-based databases
  if (!dataDir.startsWith("memory://")) {
    mkdirSync(dataDir, { recursive: true });
  }

  const createdDb = new PGlite(dataDir);
  dbCache.set(dataDir, createdDb);
  return createdDb;
}
