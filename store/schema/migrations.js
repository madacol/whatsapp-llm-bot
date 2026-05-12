import { createLogger } from "../../logger.js";

const log = createLogger("store:migrations");

/**
 * Create and repair the current root store schema.
 * @param {PGlite} db
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
        conflicted_files JSONB NOT NULL DEFAULT '[]',
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

    await Promise.all([
      db.sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS workspace_chat_subject TEXT`,
      db.sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS conflicted_files JSONB NOT NULL DEFAULT '[]'`,
      db.sql`ALTER TABLE projects ALTER COLUMN control_chat_id DROP NOT NULL`,
    ]);

    await db.sql`UPDATE workspaces SET workspace_chat_subject = name WHERE workspace_chat_subject IS NULL`;
  } catch (error) {
    log.error("⚠️ SCHEMA MIGRATION FAILED — the database may be in an inconsistent state!", error);
    log.error("⚠️ Review the error above and fix manually if needed. The bot will continue but may malfunction.");
  }
}
