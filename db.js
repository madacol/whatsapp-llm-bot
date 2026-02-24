import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";

/** @type {Map<string, PGlite>} */
const dbCache = new Map();

/** @type {PGlite | null} */
let sharedTestDb = null;

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

  // In test mode, reuse a single shared in-memory PGlite to avoid OOM
  if (process.env.TESTING) {
    if (!sharedTestDb) {
      sharedTestDb = new PGlite("memory://");
    }
    dbCache.set(dataDir, sharedTestDb);
    return sharedTestDb;
  }

  // Ensure parent directories exist for file-based databases
  if (!dataDir.startsWith("memory://")) {
    mkdirSync(dataDir, { recursive: true });
  }

  const createdDb = new PGlite(dataDir);
  dbCache.set(dataDir, createdDb);
  return createdDb;
}

const BASE_DIR = "./pgdata";

/**
 * Get the root database (shared across all chats).
 * @returns {PGlite}
 */
export function getRootDb() {
  return getDb(`${BASE_DIR}/root`);
}

/**
 * Get a chat-scoped database.
 * @param {string} chatId
 * @returns {PGlite}
 */
export function getChatDb(chatId) {
  return getDb(`${BASE_DIR}/${chatId}`);
}

/**
 * Get an action-scoped database (per chat, per action).
 * @param {string} chatId
 * @param {string} actionName
 * @returns {PGlite}
 */
export function getActionDb(chatId, actionName) {
  return getDb(`${BASE_DIR}/${chatId}/${actionName}`);
}

/**
 * Close all cached PGlite instances and clear the cache.
 */
export async function closeAllDbs() {
  const entries = [...dbCache.entries()];
  dbCache.clear();
  for (const [, db] of entries) {
    try {
      await db.close();
    } catch {
      // already closed
    }
  }
}
