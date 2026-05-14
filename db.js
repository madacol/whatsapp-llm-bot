import { getChatActionSqlitePath, getChatSqlitePath } from "./chat-paths.js";
import { createLogger } from "./logger.js";
import { createProcessDiagnosticSnapshot, formatProcessDiagnosticSnapshot } from "./process-diagnostics.js";
import { SqliteDb } from "./sqlite-db.js";

const log = createLogger("db");

/** @type {Map<string, SqliteDb>} */
const sqliteDbCache = new Map();

/** Auto-close timers for in-memory DBs (evicted after MEMORY_DB_TTL_MS of inactivity) */
const MEMORY_DB_TTL_MS = 10_000;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const memoryDbTimers = new Map();

let nextDbCacheDiagnosticSize = 10;

/**
 * @param {string} key
 * @param {SqliteDb} instance
 */
export function setDb(key, instance) {
  sqliteDbCache.set(key, instance);
}

/**
 * @param {string} filename
 * @param {SqliteDb} instance
 */
export function setSqliteDb(filename, instance) {
  sqliteDbCache.set(filename, instance);
}

/**
 * Compatibility entrypoint for older callers that requested a database by
 * logical data directory. New code should prefer the explicit root/chat/action
 * helpers below.
 * @param {string} key
 * @returns {SqliteDb}
 */
export function getDb(key) {
  const isMemory = key.startsWith("memory://");
  const cached = sqliteDbCache.get(key);
  if (cached) {
    if (isMemory) resetMemoryDbTimer(key);
    return cached;
  }

  const createdDb = new SqliteDb(isMemory ? ":memory:" : sqliteFilenameForKey(key));
  sqliteDbCache.set(key, createdDb);
  logDbCacheGrowth();

  if (isMemory) resetMemoryDbTimer(key);

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
    const db = sqliteDbCache.get(dataDir);
    if (db) {
      sqliteDbCache.delete(dataDir);
      try { await db.close(); } catch { /* already closed */ }
    }
  }, MEMORY_DB_TTL_MS);

  // Don't keep the process alive just for DB cleanup
  timer.unref();
  memoryDbTimers.set(dataDir, timer);
}

const BASE_DIR = "./pgdata";
const ROOT_DB_KEY = `${BASE_DIR}/root`;
const ROOT_SQLITE_PATH = `${BASE_DIR}/root.sqlite`;

/**
 * @param {string} key
 * @returns {string}
 */
function sqliteFilenameForKey(key) {
  return key.endsWith(".sqlite") ? key : `${key}.sqlite`;
}

/**
 * Get the root database (shared across all chats).
 * @returns {SqliteDb}
 */
export function getRootDb() {
  const injected = sqliteDbCache.get(ROOT_DB_KEY);
  if (injected) return injected;
  return getSqliteDb(ROOT_SQLITE_PATH);
}

/**
 * Get a chat-scoped database.
 * @param {string} chatId
 * @returns {SqliteDb}
 */
export function getChatDb(chatId) {
  return getSqliteDb(getChatSqlitePath(chatId));
}

/**
 * Get an action-scoped database (per chat, per action).
 * @param {string} chatId
 * @param {string} actionName
 * @returns {SqliteDb}
 */
export function getActionDb(chatId, actionName) {
  return getSqliteDb(getChatActionSqlitePath(chatId, actionName));
}

/**
 * Get the number of open database instances.
 * @returns {number}
 */
export function getDbCacheSize() {
  return sqliteDbCache.size;
}

/**
 * Get all cached database paths (for diagnostics).
 * @returns {string[]}
 */
export function getDbCachePaths() {
  return [...sqliteDbCache.keys()];
}

/**
 * Close all cached database instances and clear the cache.
 */
export async function closeAllDbs() {
  // Cancel all expiry timers
  for (const timer of memoryDbTimers.values()) clearTimeout(timer);
  memoryDbTimers.clear();

  const sqliteEntries = [...sqliteDbCache.entries()];
  sqliteDbCache.clear();
  nextDbCacheDiagnosticSize = 10;
  for (const [, db] of sqliteEntries) {
    try {
      await db.close();
    } catch {
      // already closed
    }
  }
}
