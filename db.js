import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdirSync } from "node:fs";
import { getChatActionSqlitePath, getChatSqlitePath } from "./chat-paths.js";
import { createLogger } from "./logger.js";
import { createProcessDiagnosticSnapshot, formatProcessDiagnosticSnapshot } from "./process-diagnostics.js";
import { SqliteDb } from "./sqlite-db.js";

const log = createLogger("db");

/** @type {Map<string, PGlite>} */
const dbCache = new Map();
/** @type {Map<string, SqliteDb>} */
const sqliteDbCache = new Map();

/** Auto-close timers for in-memory DBs (evicted after MEMORY_DB_TTL_MS of inactivity) */
const MEMORY_DB_TTL_MS = 10_000;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const memoryDbTimers = new Map();

/** @type {PGlite | null} */
let sharedTestDb = null;
let nextDbCacheDiagnosticSize = 10;

/**
 * @param {string} dataDir
 * @param {PGlite} instance
 */
export function setDb(dataDir, instance) {
  dbCache.set(dataDir, instance);
}

/**
 * @param {string} filename
 * @param {SqliteDb} instance
 */
export function setSqliteDb(filename, instance) {
  sqliteDbCache.set(filename, instance);
}

/**
 * @param {string} dataDir
 * @returns {PGlite}
 */
export function getDb(dataDir) {
  const isMemory = dataDir.startsWith("memory://");
  const db = dbCache.get(dataDir);

  if (db) {
    // Reset expiry timer on access for in-memory DBs
    if (isMemory) resetMemoryDbTimer(dataDir);
    return db;
  }

  // In test mode, reuse a single shared in-memory PGlite to avoid OOM
  if (process.env.TESTING) {
    const injectedRootDb = dbCache.get(`${BASE_DIR}/root`);
    if (injectedRootDb) {
      dbCache.set(dataDir, injectedRootDb);
      return injectedRootDb;
    }
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
  logDbCacheGrowth();

  // Auto-close in-memory DBs after inactivity to free ~20MB each
  if (isMemory) resetMemoryDbTimer(dataDir);

  return createdDb;
}

/**
 * @param {string} filename
 * @returns {SqliteDb}
 */
export function getSqliteDb(filename) {
  const cached = sqliteDbCache.get(filename);
  if (cached) {
    return cached;
  }
  const db = new SqliteDb(filename);
  sqliteDbCache.set(filename, db);
  logDbCacheGrowth();
  return db;
}

function logDbCacheGrowth() {
  if (process.env.TESTING) return;
  const shouldLogEveryOpen = process.env.DB_DIAGNOSTICS === "1";
  const cacheSize = getDbCacheSize();
  if (!shouldLogEveryOpen && cacheSize < nextDbCacheDiagnosticSize) return;
  while (nextDbCacheDiagnosticSize <= cacheSize) {
    nextDbCacheDiagnosticSize += 10;
  }
  const snapshot = createProcessDiagnosticSnapshot({
    dbCacheSize: cacheSize,
    dbCachePaths: getDbCachePaths(),
  });
  log.warn("database cache growth:", formatProcessDiagnosticSnapshot(snapshot));
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
 * @returns {SqliteDb | PGlite}
 */
export function getChatDb(chatId) {
  if (process.env.TESTING || process.env.NODE_TEST_CONTEXT) {
    return getDb(getChatSqlitePath(chatId));
  }
  return getSqliteDb(getChatSqlitePath(chatId));
}

/**
 * Get an action-scoped database (per chat, per action).
 * @param {string} chatId
 * @param {string} actionName
 * @returns {SqliteDb | PGlite}
 */
export function getActionDb(chatId, actionName) {
  if (process.env.TESTING || process.env.NODE_TEST_CONTEXT) {
    return getDb(getChatActionSqlitePath(chatId, actionName));
  }
  return getSqliteDb(getChatActionSqlitePath(chatId, actionName));
}

/**
 * Get the number of open PGlite instances.
 * @returns {number}
 */
export function getDbCacheSize() {
  return dbCache.size + sqliteDbCache.size;
}

/**
 * Get all cached database paths (for diagnostics).
 * @returns {string[]}
 */
export function getDbCachePaths() {
  return [...dbCache.keys(), ...sqliteDbCache.keys()];
}

/**
 * Close all cached PGlite instances and clear the cache.
 */
export async function closeAllDbs() {
  // Cancel all expiry timers
  for (const timer of memoryDbTimers.values()) clearTimeout(timer);
  memoryDbTimers.clear();

  const entries = [...dbCache.entries()];
  const sqliteEntries = [...sqliteDbCache.entries()];
  dbCache.clear();
  sqliteDbCache.clear();
  nextDbCacheDiagnosticSize = 10;
  for (const [, db] of entries) {
    try {
      await db.close();
    } catch {
      // already closed
    }
  }
  for (const [, db] of sqliteEntries) {
    try {
      await db.close();
    } catch {
      // already closed
    }
  }
}
