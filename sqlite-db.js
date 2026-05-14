import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const JSON_COLUMNS = new Set([
  "message_data",
  "llm_context",
  "messages",
  "usage",
  "payload_json",
  "conflicted_files",
]);

const BOOLEAN_COLUMNS = new Set([
  "delivered",
]);

/**
 * @typedef {{
 *   rows: Record<string, unknown>[];
 * }} QueryResult
 */

/**
 * Small async facade over Node's synchronous SQLite API. It intentionally
 * mirrors the PGlite surface this project uses: tagged `sql`, parameterized
 * `query`, and `close`.
 */
export class SqliteDb {
  /** @type {"sqlite"} */
  dialect = "sqlite";

  /**
   * @param {string} filename
   */
  constructor(filename) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true });
    }
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.sql = this.sql.bind(this);
    this.query = this.query.bind(this);
  }

  /**
   * @param {TemplateStringsArray} strings
   * @param {...unknown} values
   * @returns {Promise<QueryResult>}
   */
  async sql(strings, ...values) {
    let statement = strings[0] ?? "";
    for (let i = 0; i < values.length; i += 1) {
      statement += `?${strings[i + 1] ?? ""}`;
    }
    return this.query(statement, values);
  }

  /**
   * @param {string} statement
   * @param {unknown[]} [values]
   * @returns {Promise<QueryResult>}
   */
  async query(statement, values = []) {
    const normalizedStatement = normalizeStatement(statement);
    const prepared = this.db.prepare(normalizedStatement);
    const serializedValues = values.map(serializeValue);
    try {
      const rows = prepared.all(...serializedValues);
      return { rows: rows.map(deserializeRow) };
    } catch (error) {
      if (!isNoRowsStatementError(error)) {
        throw error;
      }
      prepared.run(...serializedValues);
      return { rows: [] };
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    this.db.close();
  }
}

/**
 * @param {unknown} db
 * @returns {db is SqliteDb}
 */
export function isSqliteDb(db) {
  return db instanceof SqliteDb;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function serializeValue(value) {
  if (value instanceof Date) {
    return formatSqliteTimestamp(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Format Date parameters the same way SQLite's CURRENT_TIMESTAMP default does
 * so TEXT timestamp comparisons stay lexically sortable.
 * @param {Date} value
 * @returns {string}
 */
function formatSqliteTimestamp(value) {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function deserializeRow(row) {
  /** @type {Record<string, unknown>} */
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && JSON_COLUMNS.has(key)) {
      normalized[key] = parseJsonColumn(value);
    } else if (BOOLEAN_COLUMNS.has(key) && (value === 0 || value === 1)) {
      normalized[key] = Boolean(value);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function parseJsonColumn(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Node's SQLite API separates statements that return rows from statements
 * that only report changes. Preserve this project's PGlite-like facade by
 * falling back to `run()` for DDL and non-returning mutations.
 * @param {unknown} error
 * @returns {boolean}
 */
function isNoRowsStatementError(error) {
  return error instanceof Error
    && /does not return data|Use run\(\)/i.test(error.message);
}

/**
 * Keep compatibility with the few direct `$1` queries still used in modules.
 * Tagged queries are emitted with `?` placeholders already.
 * @param {string} statement
 * @returns {string}
 */
function normalizeStatement(statement) {
  return statement.replace(/\$(\d+)/g, "?");
}
