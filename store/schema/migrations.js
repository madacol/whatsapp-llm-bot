import { createLogger } from "../../logger.js";

const log = createLogger("store:migrations");

/**
 * Create and repair the current root store schema.
 * @param {import("../../sqlite-db.js").SqliteDb} db
 * @returns {Promise<void>}
 */
export async function runStoreMigrations(db) {
  try {
    await db.sql`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        default_base_branch TEXT NOT NULL,
        control_chat_id VARCHAR(50) REFERENCES chats(chat_id) UNIQUE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await db.sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        workspace_chat_id VARCHAR(50) NOT NULL REFERENCES chats(chat_id) UNIQUE,
        workspace_chat_subject TEXT,
        last_test_status TEXT NOT NULL DEFAULT 'not_run',
        last_commit_oid TEXT,
        conflicted_files TEXT NOT NULL DEFAULT '[]',
        archived_at TIMESTAMP,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (project_id, name)
      );
    `;

    await db.sql`
      CREATE TABLE IF NOT EXISTS chat_bindings (
        chat_id VARCHAR(50) PRIMARY KEY REFERENCES chats(chat_id),
        binding_kind TEXT NOT NULL,
        project_id TEXT REFERENCES projects(project_id),
        workspace_id TEXT REFERENCES workspaces(workspace_id) UNIQUE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await db.sql`
      CREATE TABLE IF NOT EXISTS whatsapp_workspace_presentations (
        workspace_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_chat_id VARCHAR(50) NOT NULL REFERENCES chats(chat_id) UNIQUE,
        workspace_chat_subject TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'workspace',
        linked_community_chat_id VARCHAR(50) REFERENCES chats(chat_id),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await db.sql`
      CREATE TABLE IF NOT EXISTS whatsapp_edit_handles (
        id TEXT PRIMARY KEY,
        chat_id VARCHAR(50) NOT NULL REFERENCES chats(chat_id),
        message_key_json TEXT NOT NULL,
        message_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `;

    await db.sql`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_edit_handles_expires_at
      ON whatsapp_edit_handles (expires_at);
    `;

    await db.sql`
      CREATE TABLE IF NOT EXISTS whatsapp_ingress_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingress_key TEXT NOT NULL UNIQUE,
        source_event_type TEXT NOT NULL,
        chat_id VARCHAR(50) NOT NULL REFERENCES chats(chat_id),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'received',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await db.sql`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_ingress_journal_state_id
      ON whatsapp_ingress_journal (state, id);
    `;

    await db.sql`
      CREATE TABLE IF NOT EXISTS harness_live_input_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id VARCHAR(50) NOT NULL REFERENCES chats(chat_id),
        turn_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await db.sql`
      CREATE INDEX IF NOT EXISTS idx_harness_live_input_journal_chat_id
      ON harness_live_input_journal (chat_id, id);
    `;

    await addColumnIfMissing(db, "workspaces", "workspace_chat_subject", "workspace_chat_subject TEXT");
    await addColumnIfMissing(db, "workspaces", "conflicted_files", "conflicted_files TEXT NOT NULL DEFAULT '[]'");

    await db.sql`UPDATE workspaces SET workspace_chat_subject = name WHERE workspace_chat_subject IS NULL`;
  } catch (error) {
    log.error("⚠️ SCHEMA MIGRATION FAILED — the database may be in an inconsistent state!", error);
    log.error("⚠️ Review the error above and fix manually if needed. The bot will continue but may malfunction.");
  }
}

/**
 * @param {import("../../sqlite-db.js").SqliteDb} db
 * @param {string} tableName
 * @param {string} columnName
 * @param {string} columnDefinition
 * @returns {Promise<void>}
 */
async function addColumnIfMissing(db, tableName, columnName, columnDefinition) {
  const { rows } = await db.query(`PRAGMA table_info(${tableName})`);
  const hasColumn = rows.some((row) => row.name === columnName);
  if (!hasColumn) {
    await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}
