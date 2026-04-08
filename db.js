import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdirSync } from "node:fs";

const BASE_DIR = "./pgdata";

/** @type {Map<string, PGlite>} */
const dbCache = new Map();

/** Auto-close timers for in-memory DBs (evicted after MEMORY_DB_TTL_MS of inactivity) */
const MEMORY_DB_TTL_MS = 10_000;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const memoryDbTimers = new Map();

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
  const isMemory = dataDir.startsWith("memory://");
  const usesDefaultTestPath = dataDir === BASE_DIR || dataDir.startsWith(`${BASE_DIR}/`);
  const db = dbCache.get(dataDir);

  if (db) {
    // Reset expiry timer on access for in-memory DBs
    if (isMemory) resetMemoryDbTimer(dataDir);
    return db;
  }

  // In test mode, reuse a single shared in-memory PGlite to avoid OOM
  if (process.env.TESTING && (isMemory || usesDefaultTestPath)) {
    if (!sharedTestDb) {
      sharedTestDb = new PGlite("memory://", { extensions: { vector } });
    }
    dbCache.set(dataDir, sharedTestDb);
    return sharedTestDb;
  }

  // Ensure parent directories exist for file-based databases
  if (!isMemory) {
    mkdirSync(dataDir, { recursive: true });
  }

  const createdDb = new PGlite(dataDir, { extensions: { vector } });
  dbCache.set(dataDir, createdDb);

  // Auto-close in-memory DBs after inactivity to free ~20MB each
  if (isMemory) resetMemoryDbTimer(dataDir);

  return createdDb;
}

/**
 * Reset (or start) the auto-close timer for an in-memory DB.
 * After MEMORY_DB_TTL_MS of inactivity, the DB is closed and evicted.
 * @param {string} dataDir
 */
function resetMemoryDbTimer(dataDir) {
  const existing = memoryDbTimers.get(dataDir);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    memoryDbTimers.delete(dataDir);
    const db = dbCache.get(dataDir);
    if (db) {
      dbCache.delete(dataDir);
      try { await db.close(); } catch { /* already closed */ }
    }
  }, MEMORY_DB_TTL_MS);

  // Don't keep the process alive just for DB cleanup
  timer.unref();
  memoryDbTimers.set(dataDir, timer);
}

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
 * Get the number of open PGlite instances.
 * @returns {number}
 */
export function getDbCacheSize() {
  return dbCache.size;
}

/**
 * Get all cached database paths (for diagnostics).
 * @returns {string[]}
 */
export function getDbCachePaths() {
  return [...dbCache.keys()];
}

/**
 * Close all cached PGlite instances and clear the cache.
 */
export async function closeAllDbs() {
  // Cancel all expiry timers
  for (const timer of memoryDbTimers.values()) clearTimeout(timer);
  memoryDbTimers.clear();

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
