#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { isRuntimeStateSnapshotPath } from "../snapshot-file-policy.js";

/**
 * @typedef {{
 *   id: number,
 *   chat_id: string,
 *   payload_json: string,
 *   created_at: string | null,
 * }} QueueRow
 */

/**
 * @param {string[]} argv
 * @returns {{ chatDb: string | null, apply: boolean }}
 */
function parseArgs(argv) {
  /** @type {string | null} */
  let chatDb = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--chat-db") {
      chatDb = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { chatDb, apply };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textFromContent(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "")
    .join("");
}

/**
 * @param {unknown} event
 * @returns {boolean}
 */
function isTransientStatusEvent(event) {
  if (!isRecord(event) || event.kind !== "content") {
    return false;
  }
  const source = event.source;
  const text = textFromContent(event.content).trim();
  return source === "plain" && (
    /^codex session ready$/i.test(text)
    || /^codex turn completed$/i.test(text)
    || /^acp assistant item started$/i.test(text)
    || /^🔧 \*.+\*$/.test(text)
  );
}

/**
 * @param {QueueRow} row
 * @returns {{ payload: unknown, reason: string } | null}
 */
function classifyRow(row) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return { payload: row.payload_json, reason: "payload_json is not valid JSON" };
  }
  if (!isRecord(payload)) {
    return { payload, reason: "payload is not an object" };
  }
  if (payload.kind !== "event" && payload.kind !== "text") {
    return { payload, reason: "unknown queue payload kind" };
  }
  if (payload.kind === "text") {
    return null;
  }
  if (!isRecord(payload.event)) {
    return { payload, reason: "event is not an object" };
  }
  if (
    payload.event.kind === "file_change"
    && typeof payload.event.path === "string"
    && isRuntimeStateSnapshotPath(payload.event.path)
  ) {
    return { payload, reason: "ignored runtime-state file change" };
  }
  if (isTransientStatusEvent(payload.event)) {
    return { payload, reason: "transient presentation status" };
  }
  return null;
}

/**
 * @param {DatabaseSync} db
 * @returns {void}
 */
function ensureDeadLetterTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_outbound_dead_letter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_queue_id INTEGER,
      chat_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT,
      quarantined_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * @param {DatabaseSync} db
 * @param {QueueRow} row
 * @param {string} reason
 * @returns {void}
 */
function quarantineRow(db, row, reason) {
  db.prepare(`
    INSERT INTO whatsapp_outbound_dead_letter (
      original_queue_id,
      chat_id,
      payload_json,
      reason,
      created_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.chat_id, row.payload_json, reason, row.created_at);
  db.prepare("DELETE FROM whatsapp_outbound_queue WHERE id = ?").run(row.id);
}

const { chatDb, apply } = parseArgs(process.argv.slice(2));
if (!chatDb) {
  console.error("Usage: pnpm exec node scripts/whatsapp-outbound-queue-cleanup.js --chat-db /path/to/chat.sqlite [--apply]");
  process.exit(2);
}

const db = new DatabaseSync(chatDb);
if (apply) {
  ensureDeadLetterTable(db);
}
const rows = /** @type {QueueRow[]} */ (db.prepare(`
  SELECT id, chat_id, payload_json, created_at
  FROM whatsapp_outbound_queue
  ORDER BY id ASC
`).all());

/** @type {Array<{ row: QueueRow, reason: string }>} */
const candidates = [];
for (const row of rows) {
  const classification = classifyRow(row);
  if (classification) {
    candidates.push({ row, reason: classification.reason });
  }
}

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  totalRows: rows.length,
  candidateRows: candidates.length,
  candidates: candidates.map(({ row, reason }) => ({
    id: row.id,
    chatId: row.chat_id,
    createdAt: row.created_at,
    reason,
  })),
}, null, 2));

if (apply) {
  db.exec("BEGIN");
  try {
    for (const { row, reason } of candidates) {
      quarantineRow(db, row, reason);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

db.close();
