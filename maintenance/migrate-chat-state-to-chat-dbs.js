#!/usr/bin/env node

import { closeAllDbs, getChatDb, getRootDb } from "../db.js";
import { ensureChatDirs } from "../chat-paths.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapStoreSchema } from "../store/schema/bootstrap.js";
import { ensureChatStoreSchema } from "../store/schema/chat.js";
import { runStoreMigrations } from "../store/schema/migrations.js";

const CHAT_SCOPED_TABLES = [
  { table: "messages", key: "message_id" },
  { table: "memories", key: "id" },
  { table: "reminders", key: "id" },
  { table: "usage_logs", key: "id" },
  { table: "agent_runs", key: "id" },
  { table: "whatsapp_outbound_queue", key: "id" },
];

const ROOT_ONLY_UNATTRIBUTED_TABLES = ["html_pages", "media_to_text_cache"];
const BACKUP_DIR = resolve("data", "recovery-backups");

/**
 * @param {string} value
 * @returns {string}
 */
function quoteIdent(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * @param {PGlite} db
 * @param {string} table
 * @returns {Promise<boolean>}
 */
async function tableExists(db, table) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

/**
 * @param {PGlite} db
 * @param {string} table
 * @returns {Promise<string[]>}
 */
async function getColumns(db, table) {
  const { rows } = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return rows
    .map((row) => row.column_name)
    .filter(/** @returns {value is string} */ (value) => typeof value === "string");
}

/**
 * @param {PGlite} sourceDb
 * @returns {Promise<string[]>}
 */
async function collectChatIds(sourceDb) {
  /** @type {Set<string>} */
  const chatIds = new Set();
  if (await tableExists(sourceDb, "chats")) {
    const { rows } = await sourceDb.sql`SELECT chat_id FROM chats`;
    for (const row of rows) {
      if (typeof row.chat_id === "string") {
        chatIds.add(row.chat_id);
      }
    }
  }
  for (const { table } of CHAT_SCOPED_TABLES) {
    if (!await tableExists(sourceDb, table)) {
      continue;
    }
    const { rows } = await sourceDb.query(`SELECT DISTINCT chat_id FROM ${quoteIdent(table)}`);
    for (const row of rows) {
      if (typeof row.chat_id === "string") {
        chatIds.add(row.chat_id);
      }
    }
  }
  return [...chatIds].sort();
}

/**
 * @param {PGlite} sourceDb
 * @param {PGlite} targetDb
 * @param {string} table
 * @param {string} key
 * @param {string} chatId
 * @returns {Promise<{ copied: number, moved: number }>}
 */
async function copyRowsForChat(sourceDb, targetDb, table, key, chatId) {
  if (!await tableExists(sourceDb, table)) {
    return { copied: 0, moved: 0 };
  }

  const sourceColumns = await getColumns(sourceDb, table);
  const targetColumns = await getColumns(targetDb, table);
  const targetColumnSet = new Set(targetColumns);
  const columns = sourceColumns.filter((column) => targetColumnSet.has(column));
  if (!columns.includes(key) || !columns.includes("chat_id")) {
    throw new Error(`Table ${table} is missing required migration columns.`);
  }

  const columnSql = columns.map(quoteIdent).join(", ");
  const { rows } = await sourceDb.query(
    `SELECT ${columnSql}
     FROM ${quoteIdent(table)}
     WHERE chat_id = $1
     ORDER BY ${quoteIdent(key)}`,
    [chatId],
  );
  if (rows.length === 0) {
    return { copied: 0, moved: 0 };
  }

  const moved = await moveConflictingTargetRows({
    sourceRows: rows,
    targetDb,
    table,
    key,
    chatId,
    columns,
  });

  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const updateColumns = columns.filter((column) => column !== key);
  const updateSql = updateColumns.length > 0
    ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(", ")}`
    : "DO NOTHING";
  const insertSql = `INSERT INTO ${quoteIdent(table)} (${columnSql})
    VALUES (${placeholders})
    ON CONFLICT (${quoteIdent(key)}) ${updateSql}`;

  for (const row of rows) {
    await targetDb.query(insertSql, columns.map((column) => row[column]));
  }

  await syncSerialSequence(targetDb, table, key);
  return { copied: rows.length, moved };
}

/**
 * @param {PGlite} sourceDb
 * @param {PGlite} targetDb
 * @param {string} chatId
 * @returns {Promise<number>}
 */
async function copyChatSettings(sourceDb, targetDb, chatId) {
  if (!await tableExists(sourceDb, "chats")) {
    return 0;
  }

  const sourceColumns = await getColumns(sourceDb, "chats");
  const targetColumns = await getColumns(targetDb, "chats");
  const targetColumnSet = new Set(targetColumns);
  const columns = sourceColumns.filter((column) => targetColumnSet.has(column));
  if (!columns.includes("chat_id")) {
    throw new Error("chats table is missing chat_id.");
  }

  const columnSql = columns.map(quoteIdent).join(", ");
  const { rows } = await sourceDb.query(
    `SELECT ${columnSql} FROM chats WHERE chat_id = $1`,
    [chatId],
  );
  if (rows.length === 0) {
    await targetDb.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING`;
    return 0;
  }

  const { rows: [existingTargetRow] } = await targetDb.query(
    `SELECT ${columnSql} FROM chats WHERE chat_id = $1`,
    [chatId],
  );
  const row = mergeChatSettingsRow(rows[0], existingTargetRow, columns);

  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const updateColumns = columns.filter((column) => column !== "chat_id");
  const updateSql = updateColumns.length > 0
    ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(", ")}`
    : "DO NOTHING";
  await targetDb.query(
    `INSERT INTO chats (${columnSql})
     VALUES (${placeholders})
     ON CONFLICT (chat_id) ${updateSql}`,
    columns.map((column) => row[column]),
  );
  return 1;
}

/**
 * Restore legacy root settings while preserving any post-refactor local
 * harness session as a history entry instead of discarding it.
 * @param {Record<string, unknown>} sourceRow
 * @param {Record<string, unknown> | undefined} targetRow
 * @param {string[]} columns
 * @returns {Record<string, unknown>}
 */
function mergeChatSettingsRow(sourceRow, targetRow, columns) {
  const row = { ...sourceRow };
  if (!targetRow) {
    return row;
  }

  if (columns.includes("harness_session_id") && columns.includes("harness_session_kind")) {
    const sourceSession = getSessionRef(sourceRow);
    const targetSession = getSessionRef(targetRow);
    const history = mergeHarnessHistory(
      sourceRow.harness_session_history,
      targetRow.harness_session_history,
    );

    if (sourceSession) {
      row.harness_session_id = sourceSession.id;
      row.harness_session_kind = sourceSession.kind;
      if (targetSession && !sameSession(sourceSession, targetSession)) {
        addHistoryEntry(history, {
          ...targetSession,
          cleared_at: new Date().toISOString(),
          title: "Post-refactor local session",
        });
      }
    } else if (targetSession) {
      row.harness_session_id = targetSession.id;
      row.harness_session_kind = targetSession.kind;
    }

    row.harness_session_history = history;
  }

  return row;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{ id: string, kind: string } | null}
 */
function getSessionRef(row) {
  return typeof row.harness_session_id === "string" && typeof row.harness_session_kind === "string"
    ? { id: row.harness_session_id, kind: row.harness_session_kind }
    : null;
}

/**
 * @param {{ id: string, kind: string }} a
 * @param {{ id: string, kind: string }} b
 * @returns {boolean}
 */
function sameSession(a, b) {
  return a.id === b.id && a.kind === b.kind;
}

/**
 * @param {unknown} sourceHistory
 * @param {unknown} targetHistory
 * @returns {{ id: string, kind: string, cleared_at: string, title: string | null }[]}
 */
function mergeHarnessHistory(sourceHistory, targetHistory) {
  /** @type {{ id: string, kind: string, cleared_at: string, title: string | null }[]} */
  const history = [];
  for (const value of [sourceHistory, targetHistory]) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const rawEntry of value) {
      if (!rawEntry || typeof rawEntry !== "object") {
        continue;
      }
      const entry = /** @type {Record<string, unknown>} */ (rawEntry);
      if (
        typeof entry.id !== "string"
        || typeof entry.kind !== "string"
        || typeof entry.cleared_at !== "string"
      ) {
        continue;
      }
      addHistoryEntry(history, {
        id: entry.id,
        kind: entry.kind,
        cleared_at: entry.cleared_at,
        title: typeof entry.title === "string" && entry.title.trim() ? entry.title : null,
      });
    }
  }
  return history;
}

/**
 * @param {{ id: string, kind: string, cleared_at: string, title: string | null }[]} history
 * @param {{ id: string, kind: string, cleared_at: string, title: string | null }} entry
 * @returns {void}
 */
function addHistoryEntry(history, entry) {
  if (!history.some((existing) => existing.id === entry.id && existing.kind === entry.kind)) {
    history.push(entry);
  }
}

/**
 * @param {{
 *   sourceRows: Record<string, unknown>[],
 *   targetDb: PGlite,
 *   table: string,
 *   key: string,
 *   chatId: string,
 *   columns: string[],
 * }} input
 * @returns {Promise<number>}
 */
async function moveConflictingTargetRows({ sourceRows, targetDb, table, key, chatId, columns }) {
  const sourceMax = getMaxKey(sourceRows, key);
  const { rows: [targetMaxRow] } = await targetDb.query(
    `SELECT COALESCE(MAX(${quoteIdent(key)}), 0)::int AS max_id FROM ${quoteIdent(table)}`,
  );
  const targetMax = Number(targetMaxRow?.max_id ?? 0);
  const reservedSequenceValue = Math.max(sourceMax, targetMax) + 100_000;
  await setSerialSequence(targetDb, table, key, reservedSequenceValue);

  let nextAvailableId = Math.max(sourceMax, targetMax) + 1;
  let moved = 0;
  const sourceByKey = new Map(sourceRows.map((row) => [normalizeInteger(row[key]), row]));

  for (const [rawKey, sourceRow] of sourceByKey.entries()) {
    if (rawKey === null) {
      continue;
    }
    const { rows: [targetRow] } = await targetDb.query(
      `SELECT ${columns.map(quoteIdent).join(", ")}
       FROM ${quoteIdent(table)}
       WHERE ${quoteIdent(key)} = $1 AND chat_id = $2`,
      [rawKey, chatId],
    );
    if (!targetRow || rowsEquivalent(sourceRow, targetRow, columns)) {
      continue;
    }
    await targetDb.query(
      `UPDATE ${quoteIdent(table)}
       SET ${quoteIdent(key)} = $1
       WHERE ${quoteIdent(key)} = $2 AND chat_id = $3`,
      [nextAvailableId, rawKey, chatId],
    );
    nextAvailableId += 1;
    moved += 1;
  }

  return moved;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} key
 * @returns {number}
 */
function getMaxKey(rows, key) {
  return rows.reduce((max, row) => {
    const value = normalizeInteger(row[key]);
    return value !== null && value > max ? value : max;
  }, 0);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeInteger(value) {
  if (Number.isInteger(value)) {
    return /** @type {number} */ (value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * @param {Record<string, unknown>} sourceRow
 * @param {Record<string, unknown>} targetRow
 * @param {string[]} columns
 * @returns {boolean}
 */
function rowsEquivalent(sourceRow, targetRow, columns) {
  return columns.every((column) => stableStringify(sourceRow[column]) === stableStringify(targetRow[column]));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {PGlite} db
 * @param {string} table
 * @param {string} column
 * @returns {Promise<void>}
 */
async function syncSerialSequence(db, table, column) {
  const { rows } = await db.query(
    `SELECT MAX(${quoteIdent(column)}) AS max_id FROM ${quoteIdent(table)}`,
  );
  const maxId = Number(rows[0]?.max_id ?? 0);
  if (!Number.isFinite(maxId) || maxId <= 0) {
    return;
  }
  await setSerialSequence(db, table, column, maxId);
}

/**
 * @param {PGlite} db
 * @param {string} table
 * @param {string} column
 * @param {number} value
 * @returns {Promise<void>}
 */
async function setSerialSequence(db, table, column, value) {
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  await db.query(
    `SELECT setval(pg_get_serial_sequence($1, $2), $3, true)`,
    [table, column, value],
  );
}

/**
 * @param {PGlite} rootDb
 * @returns {Promise<void>}
 */
async function warnAboutUnattributedRootTables(rootDb) {
  for (const table of ROOT_ONLY_UNATTRIBUTED_TABLES) {
    if (!await tableExists(rootDb, table)) {
      continue;
    }
    const { rows } = await rootDb.query(`SELECT count(*)::int AS count FROM ${quoteIdent(table)}`);
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0) {
      console.warn(`WARN skipped ${count} row(s) in ${table}; the legacy table has no chat_id to migrate safely.`);
    }
  }
}

/**
 * @param {PGlite} db
 * @param {string} table
 * @param {string} chatId
 * @param {string} [key]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function selectRowsForBackup(db, table, chatId, key = "id") {
  if (!await tableExists(db, table)) {
    return [];
  }
  const columns = await getColumns(db, table);
  const orderColumn = columns.includes(key) ? key : "chat_id";
  const { rows } = await db.query(
    `SELECT * FROM ${quoteIdent(table)} WHERE chat_id = $1 ORDER BY ${quoteIdent(orderColumn)}`,
    [chatId],
  );
  return rows;
}

/**
 * @param {PGlite} rootDb
 * @param {string[]} chatIds
 * @returns {Promise<string>}
 */
async function writeLogicalBackup(rootDb, chatIds) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  /** @type {{
   *   created_at: string,
   *   root: {
   *     chats: Record<string, unknown>[],
   *     tables: Record<string, Record<string, unknown>[]>,
   *   },
   *   chat_dbs: Record<string, {
   *     chats: Record<string, unknown>[],
   *     tables: Record<string, Record<string, unknown>[]>,
   *   }>,
   * }}
   */
  const backup = {
    created_at: new Date().toISOString(),
    root: {
      chats: [],
      tables: {},
    },
    chat_dbs: {},
  };

  if (await tableExists(rootDb, "chats")) {
    const { rows } = await rootDb.query("SELECT * FROM chats ORDER BY chat_id");
    backup.root.chats = rows;
  }
  for (const { table, key } of CHAT_SCOPED_TABLES) {
    if (!await tableExists(rootDb, table)) {
      continue;
    }
    const { rows } = await rootDb.query(`SELECT * FROM ${quoteIdent(table)} ORDER BY chat_id, ${quoteIdent(key)}`);
    backup.root.tables[table] = rows;
  }

  for (const chatId of chatIds) {
    const chatDb = getChatDb(chatId);
    /** @type {{ chats: Record<string, unknown>[], tables: Record<string, Record<string, unknown>[]> }} */
    const chatBackup = { chats: [], tables: {} };
    if (await tableExists(chatDb, "chats")) {
      const { rows } = await chatDb.query("SELECT * FROM chats WHERE chat_id = $1", [chatId]);
      chatBackup.chats = rows;
    }
    for (const { table, key } of CHAT_SCOPED_TABLES) {
      chatBackup.tables[table] = await selectRowsForBackup(chatDb, table, chatId, key);
    }
    backup.chat_dbs[chatId] = chatBackup;
  }

  const backupPath = resolve(
    BACKUP_DIR,
    `chat-state-to-chat-dbs-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`);
  return backupPath;
}

async function main() {
  const rootDb = getRootDb();
  await bootstrapStoreSchema(rootDb);
  await runStoreMigrations(rootDb);

  const chatIds = await collectChatIds(rootDb);
  console.log(`Migrating chat-owned root state for ${chatIds.length} chat(s).`);
  const backupPath = await writeLogicalBackup(rootDb, chatIds);
  console.log(`Wrote logical backup to ${backupPath}`);

  for (const chatId of chatIds) {
    ensureChatDirs(chatId);
    const chatDb = getChatDb(chatId);
    await ensureChatStoreSchema(chatDb);

    const tableCounts = new Map();
    tableCounts.set("chats", { copied: await copyChatSettings(rootDb, chatDb, chatId), moved: 0 });
    for (const { table, key } of CHAT_SCOPED_TABLES) {
      tableCounts.set(table, await copyRowsForChat(rootDb, chatDb, table, key, chatId));
    }

    const summary = [...tableCounts.entries()]
      .filter(([, count]) => count.copied > 0 || count.moved > 0)
      .map(([table, count]) => `${table}:${count.copied}${count.moved ? ` moved-local:${count.moved}` : ""}`)
      .join(", ");
    console.log(`${chatId}\t${summary || "no rows"}`);
  }

  await warnAboutUnattributedRootTables(rootDb);
  await closeAllDbs();
}

main().catch(async (error) => {
  console.error(error);
  await closeAllDbs();
  process.exitCode = 1;
});
