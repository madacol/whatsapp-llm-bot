import { compactOutputVisibilityOverrides } from "../../chat-output-visibility.js";
import { normalizeHarnessConfig } from "../../harness-config.js";
import { createLogger } from "../../logger.js";

const log = createLogger("store:migrations");

/**
 * Run schema migrations and data repairs for the root store database.
 * @param {PGlite} db
 * @returns {Promise<void>}
 */
export async function runStoreMigrations(db) {
  try {
    await db.sql`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'repos'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'projects'
      ) THEN
        ALTER TABLE repos RENAME TO projects;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'whatsapp_repo_presentations'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentations'
      ) THEN
        ALTER TABLE whatsapp_repo_presentations RENAME TO whatsapp_project_presentations;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentations'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache'
      ) THEN
        ALTER TABLE whatsapp_project_presentations RENAME TO whatsapp_project_presentation_cache;
      END IF;
    END $$`;

    await db.sql`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'repo_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'project_id'
      ) THEN
        ALTER TABLE projects RENAME COLUMN repo_id TO project_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'repo_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'project_id'
      ) THEN
        ALTER TABLE workspaces RENAME COLUMN repo_id TO project_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_bindings' AND column_name = 'repo_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_bindings' AND column_name = 'project_id'
      ) THEN
        ALTER TABLE chat_bindings RENAME COLUMN repo_id TO project_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'repo_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'project_id'
      ) THEN
        ALTER TABLE whatsapp_project_presentation_cache RENAME COLUMN repo_id TO project_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'topology_kind'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'cached_topology_kind'
      ) THEN
        ALTER TABLE whatsapp_project_presentation_cache RENAME COLUMN topology_kind TO cached_topology_kind;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'community_chat_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'cached_community_chat_id'
      ) THEN
        ALTER TABLE whatsapp_project_presentation_cache RENAME COLUMN community_chat_id TO cached_community_chat_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'main_workspace_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_project_presentation_cache' AND column_name = 'cached_main_workspace_id'
      ) THEN
        ALTER TABLE whatsapp_project_presentation_cache RENAME COLUMN main_workspace_id TO cached_main_workspace_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_workspace_presentations' AND column_name = 'repo_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_workspace_presentations' AND column_name = 'project_id'
      ) THEN
        ALTER TABLE whatsapp_workspace_presentations RENAME COLUMN repo_id TO project_id;
      END IF;
    END $$`;

    await db.sql`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
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
      CREATE TABLE IF NOT EXISTS whatsapp_project_presentation_cache (
        project_id TEXT PRIMARY KEY,
        cached_topology_kind TEXT NOT NULL DEFAULT 'groups',
        cached_community_chat_id VARCHAR(50) REFERENCES chats(chat_id),
        cached_main_workspace_id TEXT,
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
      CREATE TABLE IF NOT EXISTS messages (
        message_id SERIAL PRIMARY KEY,
        chat_id VARCHAR(50) REFERENCES chats(chat_id),
        sender_id VARCHAR(50),
        message_data JSONB,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        cleared_at TIMESTAMP
      );
    `;

    await db.sql`
      CREATE TABLE IF NOT EXISTS whatsapp_outbound_queue (
        id SERIAL PRIMARY KEY,
        chat_id VARCHAR(50) NOT NULL,
        payload_json JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await Promise.all([
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT FALSE`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS system_prompt TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_any BOOLEAN DEFAULT FALSE`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_mention BOOLEAN DEFAULT TRUE`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_reply BOOLEAN DEFAULT FALSE`,
      db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_data JSONB`,
      db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMP`,
      db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS message_type`,
      db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_call_id`,
      db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_name`,
      db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_args`,
      db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS content`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS debug BOOLEAN DEFAULT FALSE`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS content_models JSONB DEFAULT '{}'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS memory BOOLEAN DEFAULT FALSE`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS memory_threshold REAL`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on TEXT DEFAULT 'mention'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS enabled_actions JSONB DEFAULT '[]'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS model_roles JSONB DEFAULT '{}'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS active_persona TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness_cwd TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS output_visibility JSONB DEFAULT '{}'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness_config JSONB DEFAULT '{}'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness_session_id TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness_session_kind TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness_session_history JSONB DEFAULT '[]'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness_fork_stack JSONB DEFAULT '[]'`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS sdk_model TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS sdk_effort TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS sdk_session_id TEXT`,
      db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS sdk_session_history JSONB DEFAULT '[]'`,
      db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS exchange_text TEXT`,
      db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS llm_context JSONB`,
      db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS display_key TEXT`,
      db.sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS workspace_chat_subject TEXT`,
    ]);

    await db.sql`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='content_models')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='media_to_text_models')
      THEN
        ALTER TABLE chats RENAME COLUMN content_models TO media_to_text_models;
      ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='content_models')
            AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='media_to_text_models')
      THEN
        ALTER TABLE chats DROP COLUMN content_models;
      END IF;
    END $$`;
    await db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS media_to_text_models JSONB DEFAULT '{}'`;

    await db.sql`
      UPDATE chats SET respond_on = 'any'
      WHERE respond_on = 'mention' AND respond_on_any = true
    `;
    await db.sql`
      UPDATE chats SET respond_on = 'mention+reply'
      WHERE respond_on = 'mention' AND respond_on_any IS NOT TRUE
        AND respond_on_reply = true AND respond_on_mention IS NOT FALSE
    `;
    await db.sql`
      UPDATE chat_bindings
      SET binding_kind = 'project'
      WHERE binding_kind = 'repo'
    `;

    await db.sql`
      INSERT INTO whatsapp_project_presentation_cache (project_id, cached_topology_kind)
      SELECT DISTINCT project_id, 'groups'
      FROM workspaces
      ON CONFLICT (project_id) DO NOTHING
    `;
    await db.sql`
      INSERT INTO whatsapp_workspace_presentations (
        workspace_id,
        project_id,
        workspace_chat_id,
        workspace_chat_subject,
        role,
        linked_community_chat_id
      )
      SELECT
        workspace_id,
        project_id,
        workspace_chat_id,
        COALESCE(workspace_chat_subject, name),
        'workspace',
        NULL
      FROM workspaces
      ON CONFLICT (workspace_id) DO UPDATE
      SET
        project_id = EXCLUDED.project_id,
        workspace_chat_id = EXCLUDED.workspace_chat_id,
        workspace_chat_subject = EXCLUDED.workspace_chat_subject
    `;

    await db.sql`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='debug_until') THEN
        UPDATE chats SET debug = TRUE WHERE debug_until IS NOT NULL AND debug_until > NOW();
        ALTER TABLE chats DROP COLUMN debug_until;
      END IF;
    END $$`;

    await db.sql`
      UPDATE chats
      SET harness_config = jsonb_strip_nulls(jsonb_build_object(
        'model', sdk_model,
        'reasoningEffort', sdk_effort
      ))
      WHERE (harness_config IS NULL OR harness_config = '{}'::jsonb)
        AND (sdk_model IS NOT NULL OR sdk_effort IS NOT NULL)
    `;
    await db.sql`
      UPDATE chats
      SET harness_session_id = sdk_session_id,
          harness_session_kind = 'claude-sdk'
      WHERE harness_session_id IS NULL
        AND sdk_session_id IS NOT NULL
    `;

    {
      const { rows } = await db.sql`
        SELECT chat_id, harness, harness_config
        FROM chats
        WHERE harness_config IS NOT NULL
      `;
      for (const row of rows) {
        const normalizedConfig = normalizeHarnessConfig(row.harness_config, row.harness);
        if (JSON.stringify(normalizedConfig) !== JSON.stringify(row.harness_config ?? {})) {
          await db.sql`
            UPDATE chats
            SET harness_config = ${JSON.stringify(normalizedConfig)}
            WHERE chat_id = ${row.chat_id}
          `;
        }
      }
    }

    {
      const { rows } = await db.sql`
        SELECT chat_id, output_visibility
        FROM chats
        WHERE output_visibility IS NOT NULL
      `;
      for (const row of rows) {
        const compactedVisibility = compactOutputVisibilityOverrides(row.output_visibility);
        if (JSON.stringify(compactedVisibility) !== JSON.stringify(row.output_visibility ?? {})) {
          await db.sql`
            UPDATE chats
            SET output_visibility = ${JSON.stringify(compactedVisibility)}::jsonb
            WHERE chat_id = ${row.chat_id}
          `;
        }
      }
    }

    {
      const { rows } = await db.sql`
        SELECT chat_id, sdk_session_history, harness_session_history
        FROM chats
        WHERE sdk_session_history IS NOT NULL
      `;
      for (const row of rows) {
        const existingHistory = Array.isArray(row.harness_session_history) ? row.harness_session_history : [];
        if (existingHistory.length > 0) {
          continue;
        }

        const legacyHistory = Array.isArray(row.sdk_session_history) ? row.sdk_session_history : [];
        if (legacyHistory.length === 0) {
          continue;
        }

        /** @type {HarnessSessionHistoryEntry[]} */
        const migrated = [];
        for (const rawEntry of legacyHistory) {
          if (!rawEntry || typeof rawEntry !== "object") {
            continue;
          }

          const entry = /** @type {{ id?: unknown, cleared_at?: unknown }} */ (rawEntry);
          if (typeof entry.id !== "string" || typeof entry.cleared_at !== "string") {
            continue;
          }

          migrated.push({
            id: entry.id,
            kind: "claude-sdk",
            cleared_at: entry.cleared_at,
            title: null,
          });
        }

        if (migrated.length > 0) {
          await db.sql`
            UPDATE chats
            SET harness_session_history = ${JSON.stringify(migrated)}
            WHERE chat_id = ${row.chat_id}
          `;
        }
      }
    }

    await db.sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await Promise.all([
      db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector`,
      db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_text tsvector`,
      db.sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS conflicted_files JSONB NOT NULL DEFAULT '[]'`,
      db.sql`ALTER TABLE projects ALTER COLUMN control_chat_id DROP NOT NULL`,
    ]);
    await db.sql`UPDATE workspaces SET workspace_chat_subject = name WHERE workspace_chat_subject IS NULL`;
    await db.sql`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        chat_id VARCHAR(50) REFERENCES chats(chat_id),
        content TEXT NOT NULL,
        embedding vector,
        search_text tsvector,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await db.sql`CREATE INDEX IF NOT EXISTS idx_messages_search_text ON messages USING gin (search_text)`;
    await db.sql`CREATE INDEX IF NOT EXISTS idx_messages_display_key ON messages (chat_id, display_key) WHERE display_key IS NOT NULL`;
    await db.sql`CREATE INDEX IF NOT EXISTS idx_memories_search_text ON memories USING gin (search_text)`;
    await db.sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_queue_chat_id_id ON whatsapp_outbound_queue (chat_id, id)`;
    await db.sql`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id SERIAL PRIMARY KEY,
        chat_id VARCHAR(50) REFERENCES chats(chat_id),
        parent_tool_call_id TEXT,
        agent_name TEXT NOT NULL,
        messages JSONB NOT NULL,
        usage JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (error) {
    log.error("⚠️ SCHEMA MIGRATION FAILED — the database may be in an inconsistent state!", error);
    log.error("⚠️ Review the error above and fix manually if needed. The bot will continue but may malfunction.");
  }
}
