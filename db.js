import { PGlite as PGliteDriver } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import crypto from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE_DIR = "./pgdata";
const ROOT_DATA_DIR = `${BASE_DIR}/root`;

/**
 * Lightweight transaction wrapper for schema-scoped databases.
 */
class ScopedTransaction {
  /** @type {import("@electric-sql/pglite").Transaction} */
  #transaction;

  /**
   * @param {import("@electric-sql/pglite").Transaction} transaction
   */
  constructor(transaction) {
    this.#transaction = transaction;
  }

  /**
   * @template T
   * @param {string} query
   * @param {unknown[]} [params]
   * @param {import("@electric-sql/pglite").QueryOptions} [options]
   * @returns {Promise<import("@electric-sql/pglite").Results<T>>}
   */
  query(query, params, options) {
    return this.#transaction.query(query, params, options);
  }

  /**
   * @template T
   * @param {TemplateStringsArray} sqlStrings
   * @param {...unknown} params
   * @returns {Promise<import("@electric-sql/pglite").Results<T>>}
   */
  sql(sqlStrings, ...params) {
    return this.#transaction.sql(sqlStrings, ...params);
  }

  /**
   * @param {string} query
   * @param {import("@electric-sql/pglite").QueryOptions} [options]
   * @returns {Promise<Array<import("@electric-sql/pglite").Results>>}
   */
  exec(query, options) {
    return this.#transaction.exec(query, options);
  }

  /**
   * @returns {Promise<void>}
   */
  rollback() {
    return this.#transaction.rollback();
  }

  /**
   * @returns {boolean}
   */
  get closed() {
    return this.#transaction.closed;
  }
}

/**
 * Schema-scoped database wrapper that keeps logical scopes inside one
 * physical PGlite cluster.
 */
class ScopedDb {
  /** @type {PGlite} */
  #rootDb;
  /** @type {string} */
  #schemaName;

  /**
   * @param {PGlite} rootDb
   * @param {string} schemaName
   */
  constructor(rootDb, schemaName) {
    this.#rootDb = rootDb;
    this.#schemaName = schemaName;
  }

  /**
   * @returns {Promise<void>}
   */
  async #ensureSchema() {
    await ensureScopedSchema(this.#rootDb, this.#schemaName);
  }

  /**
   * @template T
   * @param {(transaction: import("@electric-sql/pglite").Transaction) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async #withScope(callback) {
    await this.#ensureSchema();
    return this.#rootDb.transaction(async (transaction) => {
      await transaction.query(getScopedSearchPathQuery(this.#schemaName));
      return callback(transaction);
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    // Scoped DBs share the root connection; closeAllDbs() closes the root once.
  }

  /**
   * @template T
   * @param {string} query
   * @param {unknown[]} [params]
   * @param {import("@electric-sql/pglite").QueryOptions} [options]
   * @returns {Promise<import("@electric-sql/pglite").Results<T>>}
   */
  query(query, params, options) {
    return this.#withScope((transaction) => transaction.query(query, params, options));
  }

  /**
   * @template T
   * @param {TemplateStringsArray} sqlStrings
   * @param {...unknown} params
   * @returns {Promise<import("@electric-sql/pglite").Results<T>>}
   */
  sql(sqlStrings, ...params) {
    return this.#withScope((transaction) => transaction.sql(sqlStrings, ...params));
  }

  /**
   * @param {string} query
   * @param {import("@electric-sql/pglite").QueryOptions} [options]
   * @returns {Promise<Array<import("@electric-sql/pglite").Results>>}
   */
  exec(query, options) {
    return this.#withScope((transaction) => transaction.exec(query, options));
  }

  /**
   * @param {string} query
   * @returns {Promise<import("@electric-sql/pglite").DescribeQueryResult>}
   */
  describeQuery(query) {
    return this.#rootDb.describeQuery(query);
  }

  /**
   * @template T
   * @param {(transaction: ScopedTransaction) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  transaction(callback) {
    return this.#withScope((transaction) => callback(new ScopedTransaction(transaction)));
  }

  /**
   * @template T
   * @param {() => Promise<T>} callback
   * @returns {Promise<T>}
   */
  runExclusive(callback) {
    return this.#rootDb.runExclusive(callback);
  }

  /**
   * @param {string} channel
   * @param {(payload: string) => void} callback
   * @returns {Promise<() => Promise<void>>}
   */
  listen(channel, callback) {
    return this.#rootDb.listen(channel, callback);
  }

  /**
   * @param {string} channel
   * @param {(payload: string) => void} [callback]
   * @returns {Promise<void>}
   */
  unlisten(channel, callback) {
    return this.#rootDb.unlisten(channel, callback);
  }

  /**
   * @param {(channel: string, payload: string) => void} callback
   * @returns {() => void}
   */
  onNotification(callback) {
    return this.#rootDb.onNotification(callback);
  }

  /**
   * @param {(channel: string, payload: string) => void} callback
   * @returns {void}
   */
  offNotification(callback) {
    this.#rootDb.offNotification(callback);
  }

  /**
   * @param {Parameters<PGlite["dumpDataDir"]>[0]} [compression]
   * @returns {ReturnType<PGlite["dumpDataDir"]>}
   */
  dumpDataDir(compression) {
    return this.#rootDb.dumpDataDir(compression);
  }

  /**
   * @returns {Promise<void>}
   */
  refreshArrayTypes() {
    return this.#rootDb.refreshArrayTypes();
  }

  /**
   * @param {Uint8Array} message
   * @param {import("@electric-sql/pglite").ExecProtocolOptions} [options]
   * @returns {Promise<Uint8Array>}
   */
  execProtocolRaw(message, options) {
    return this.#rootDb.execProtocolRaw(message, options);
  }

  /**
   * @param {Uint8Array} message
   * @param {import("@electric-sql/pglite").ExecProtocolOptions} [options]
   * @returns {Promise<import("@electric-sql/pglite").ExecProtocolResult>}
   */
  execProtocol(message, options) {
    return this.#rootDb.execProtocol(message, options);
  }

  /**
   * @returns {Promise<void>}
   */
  get waitReady() {
    return this.#rootDb.waitReady;
  }

  /**
   * @returns {import("@electric-sql/pglite").DebugLevel}
   */
  get debug() {
    return this.#rootDb.debug;
  }

  /**
   * @returns {boolean}
   */
  get ready() {
    return this.#rootDb.ready;
  }

  /**
   * @returns {boolean}
   */
  get closed() {
    return this.#rootDb.closed;
  }
}

/** @type {Map<string, PGlite>} */
const dbCache = new Map();

/** Auto-close timers for in-memory DBs (evicted after MEMORY_DB_TTL_MS of inactivity) */
const MEMORY_DB_TTL_MS = 10_000;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const memoryDbTimers = new Map();

/** @type {PGlite | null} */
let sharedTestDb = null;

/** @type {Map<string, Promise<void>>} */
const scopedSchemaCache = new Map();

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
  const db = dbCache.get(dataDir);

  if (db) {
    // Reset expiry timer on access for in-memory DBs
    if (isMemory) resetMemoryDbTimer(dataDir);
    return db;
  }

  // In test mode, reuse a single shared in-memory PGlite to avoid OOM
  if (process.env.TESTING) {
    if (!sharedTestDb) {
      sharedTestDb = new PGliteDriver("memory://", { extensions: { vector } });
    }
    dbCache.set(dataDir, sharedTestDb);
    return sharedTestDb;
  }

  // Ensure parent directories exist for file-based databases
  if (!isMemory) {
    mkdirSync(dataDir, { recursive: true });
  }

  const createdDb = new PGliteDriver(dataDir, { extensions: { vector } });
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
 * @param {string} scopeKind
 * @param {string[]} scopeParts
 * @returns {string}
 */
function getScopedSchemaName(scopeKind, scopeParts) {
  const hash = crypto
    .createHash("sha256")
    .update(`${scopeKind}\0${scopeParts.join("\0")}`)
    .digest("hex")
    .slice(0, 24);
  return `scope_${scopeKind}_${hash}`;
}

/**
 * @param {string} schemaName
 * @returns {string}
 */
function getScopedSearchPathQuery(schemaName) {
  return `SET LOCAL search_path TO "${schemaName}", public`;
}

/**
 * @param {PGlite} rootDb
 * @param {string} schemaName
 * @returns {Promise<void>}
 */
async function ensureScopedSchema(rootDb, schemaName) {
  const cached = scopedSchemaCache.get(schemaName);
  if (cached) {
    await cached;
    return;
  }

  const ready = rootDb.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`).then(() => {});
  scopedSchemaCache.set(schemaName, ready);

  try {
    await ready;
  } catch (error) {
    scopedSchemaCache.delete(schemaName);
    throw error;
  }
}

/**
 * @param {string} dataDir
 * @returns {boolean}
 */
function hasLegacyScopedData(dataDir) {
  return existsSync(path.join(dataDir, "PG_VERSION"));
}

/**
 * @param {string} cacheKey
 * @param {PGlite} ownerDb
 * @param {string} scopeKind
 * @param {string[]} scopeParts
 * @returns {PGlite}
 */
function getScopedDb(cacheKey, ownerDb, scopeKind, scopeParts) {
  const cached = dbCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Existing per-scope on-disk databases stay readable to avoid dropping user data.
  if (hasLegacyScopedData(cacheKey)) {
    return getDb(cacheKey);
  }

  const scopedDb = new ScopedDb(ownerDb, getScopedSchemaName(scopeKind, scopeParts));
  dbCache.set(cacheKey, scopedDb);
  return scopedDb;
}

/**
 * Get the root database (shared across all chats).
 * @returns {PGlite}
 */
export function getRootDb() {
  return getDb(ROOT_DATA_DIR);
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
  const dataDir = `${BASE_DIR}/${chatId}/${actionName}`;

  if (process.env.TESTING) {
    return getDb(dataDir);
  }

  return getScopedDb(dataDir, getChatDb(chatId), "action", [chatId, actionName]);
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
  scopedSchemaCache.clear();
  sharedTestDb = null;

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
