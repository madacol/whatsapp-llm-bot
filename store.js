import { getRootDb } from "./db.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";
import { normalizeHarnessConfig } from "./harness-config.js";
import { compactOutputVisibilityOverrides } from "./chat-output-visibility.js";

const log = createLogger("store");

/**
 * @typedef {{
 *   chat_id: string;
 *   is_enabled: boolean;
 *   system_prompt: string;
 *   model: string;
 *   respond_on_any: boolean;
 *   respond_on_mention: boolean;
 *   respond_on_reply: boolean;
 *   respond_on: "any" | "mention+reply" | "mention";
 *   debug: boolean;
 *   media_to_text_models: { image?: string, audio?: string, video?: string, general?: string };
 *   model_roles: Record<string, string>;
 *   memory: boolean;
 *   memory_threshold: number | null;
 *   enabled_actions: string[];
 *   active_persona: string | null;
 *   harness: string | null;
 *   harness_cwd: string | null;
 *   output_visibility: import("./chat-output-visibility.js").OutputVisibilityOverrides;
 *   harness_config: Record<string, { model?: string | null, reasoningEffort?: "low" | "medium" | "high" | "max" | null, sandboxMode?: string | null, approvalPolicy?: string | null }>;
 *   harness_session_id: string | null;
 *   harness_session_kind: HarnessSessionRef["kind"] | null;
 *   harness_session_history: HarnessSessionHistoryEntry[];
 *   harness_fork_stack: HarnessForkStackEntry[];
 *   timestamp: string;
 * }} ChatRow
 *
 * @typedef {{
 *   id: string;
 *   kind: HarnessSessionRef["kind"];
 *   cleared_at: string;
 *   title: string | null;
 * }} HarnessSessionHistoryEntry
 *
 * @typedef {{
 *   id: string;
 *   kind: HarnessSessionRef["kind"];
 *   label: string | null;
 * }} HarnessForkStackEntry
 *
 * @typedef {{
 *   message_id: number;
 *   chat_id: string;
 *   sender_id: string; // Comma-separated sender IDs (e.g. "phone_id,lid_id")
 *   message_data: Message;
 *   timestamp: Date;
 *   display_key: string | null; // Platform message ID of the display message (e.g. for tool-call inspect)
 * }} MessageRow
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is WorkspaceStatus}
 */
function isWorkspaceStatus(value) {
  return value === "ready" || value === "busy" || value === "conflicted" || value === "archived";
}

/**
 * @param {unknown} value
 * @returns {value is WorkspaceRow["last_test_status"]}
 */
function isWorkspaceTestStatus(value) {
  return value === "not_run" || value === "passed" || value === "failed";
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeTimestampValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {RepoRow | null}
 */
function normalizeRepoRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    typeof raw.repo_id !== "string"
    || typeof raw.name !== "string"
    || typeof raw.root_path !== "string"
    || typeof raw.default_base_branch !== "string"
    || (raw.control_chat_id !== null && typeof raw.control_chat_id !== "string")
    || !timestamp
  ) {
    return null;
  }
  return {
    repo_id: raw.repo_id,
    name: raw.name,
    root_path: raw.root_path,
    default_base_branch: raw.default_base_branch,
    control_chat_id: raw.control_chat_id,
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {WorkspaceRow | null}
 */
function normalizeWorkspaceRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const timestamp = normalizeTimestampValue(raw.timestamp);
  const archivedAt = raw.archived_at === null ? null : normalizeTimestampValue(raw.archived_at);
  const conflictedFiles = Array.isArray(raw.conflicted_files)
    ? raw.conflicted_files.filter((value) => typeof value === "string")
    : [];
  if (
    typeof raw.workspace_id !== "string"
    || typeof raw.repo_id !== "string"
    || typeof raw.name !== "string"
    || typeof raw.branch !== "string"
    || typeof raw.base_branch !== "string"
    || typeof raw.worktree_path !== "string"
    || !isWorkspaceStatus(raw.status)
    || typeof raw.workspace_chat_id !== "string"
    || !isWorkspaceTestStatus(raw.last_test_status)
    || (raw.last_commit_oid !== null && typeof raw.last_commit_oid !== "string")
    || (raw.archived_at !== null && !archivedAt)
    || conflictedFiles.length !== (Array.isArray(raw.conflicted_files) ? raw.conflicted_files.length : 0)
    || !timestamp
  ) {
    return null;
  }
  return {
    workspace_id: raw.workspace_id,
    repo_id: raw.repo_id,
    name: raw.name,
    branch: raw.branch,
    base_branch: raw.base_branch,
    worktree_path: raw.worktree_path,
    status: raw.status,
    workspace_chat_id: raw.workspace_chat_id,
    last_test_status: raw.last_test_status,
    last_commit_oid: raw.last_commit_oid,
    conflicted_files: conflictedFiles,
    archived_at: archivedAt,
    timestamp,
  };
}

/**
 * @param {unknown} raw
 * @returns {ChatBindingRow | null}
 */
function normalizeChatBindingRow(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const timestamp = normalizeTimestampValue(raw.timestamp);
  if (
    typeof raw.chat_id !== "string"
    || (raw.binding_kind !== "repo" && raw.binding_kind !== "workspace")
    || (raw.repo_id !== null && typeof raw.repo_id !== "string")
    || (raw.workspace_id !== null && typeof raw.workspace_id !== "string")
    || !timestamp
  ) {
    return null;
  }
  return {
    chat_id: raw.chat_id,
    binding_kind: raw.binding_kind,
    repo_id: raw.repo_id,
    workspace_id: raw.workspace_id,
    timestamp,
  };
}

/**
 * Returns the ChatRow for the given chat, or throws if it does not exist.
 * @param {PGlite} db
 * @param {string} chatId
 * @returns {Promise<ChatRow>}
 */
export async function getChatOrThrow(db, chatId) {
  const { rows: [chat] } = await db.sql`SELECT * FROM chats WHERE chat_id = ${chatId}`;
  if (!chat) {
    throw new Error(`Chat ${chatId} does not exist.`);
  }
  return /** @type {ChatRow} */ (chat);
}

/**
 * Normalize one persisted harness session history entry from JSONB.
 * @param {unknown} raw
 * @returns {HarnessSessionHistoryEntry | null}
 */
function normalizeHarnessSessionHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = /** @type {{ id?: unknown, kind?: unknown, cleared_at?: unknown, title?: unknown }} */ (raw);
  if (typeof entry.id !== "string" || typeof entry.kind !== "string" || typeof entry.cleared_at !== "string") {
    return null;
  }
  return {
    id: entry.id,
    kind: /** @type {HarnessSessionRef["kind"]} */ (entry.kind),
    cleared_at: entry.cleared_at,
    title: typeof entry.title === "string" && entry.title.trim() ? entry.title : null,
  };
}

/**
 * Normalize a JSONB array of harness session history entries.
 * @param {unknown} raw
 * @returns {HarnessSessionHistoryEntry[]}
 */
function normalizeHarnessSessionHistory(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map(normalizeHarnessSessionHistoryEntry)
    .filter(/** @returns {entry is HarnessSessionHistoryEntry} */ (entry) => entry !== null);
}

/**
 * Normalize one persisted harness fork stack entry from JSONB.
 * @param {unknown} raw
 * @returns {HarnessForkStackEntry | null}
 */
function normalizeHarnessForkStackEntry(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = /** @type {{ id?: unknown, kind?: unknown, label?: unknown }} */ (raw);
  if (typeof entry.id !== "string" || typeof entry.kind !== "string") {
    return null;
  }
  return {
    id: entry.id,
    kind: /** @type {HarnessSessionRef["kind"]} */ (entry.kind),
    label: typeof entry.label === "string" && entry.label.trim() ? entry.label : null,
  };
}

/**
 * Normalize a JSONB array of harness fork stack entries.
 * @param {unknown} raw
 * @returns {HarnessForkStackEntry[]}
 */
function normalizeHarnessForkStack(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map(normalizeHarnessForkStackEntry)
    .filter(/** @returns {entry is HarnessForkStackEntry} */ (entry) => entry !== null);
}

/**
 * @param {PGlite} [injectedDb]
 */
export async function initStore(injectedDb){
    // Initialize database
    const db = injectedDb || getRootDb();

    // Initialize database tables
    await db.sql`
        CREATE TABLE IF NOT EXISTS chats (
            chat_id VARCHAR(50) PRIMARY KEY,
            is_enabled BOOLEAN DEFAULT FALSE,
            system_prompt TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    await db.sql`
        CREATE TABLE IF NOT EXISTS repos (
            repo_id TEXT PRIMARY KEY,
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
            repo_id TEXT NOT NULL REFERENCES repos(repo_id),
            name TEXT NOT NULL,
            branch TEXT NOT NULL,
            base_branch TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready',
            workspace_chat_id VARCHAR(50) NOT NULL REFERENCES chats(chat_id) UNIQUE,
            last_test_status TEXT NOT NULL DEFAULT 'not_run',
            last_commit_oid TEXT,
            conflicted_files JSONB NOT NULL DEFAULT '[]',
            archived_at TIMESTAMP,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (repo_id, name)
        );
    `;

    await db.sql`
        CREATE TABLE IF NOT EXISTS chat_bindings (
            chat_id VARCHAR(50) PRIMARY KEY REFERENCES chats(chat_id),
            binding_kind TEXT NOT NULL,
            repo_id TEXT REFERENCES repos(repo_id),
            workspace_id TEXT REFERENCES workspaces(workspace_id) UNIQUE,
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

    // Add new columns if they don't exist (for existing databases)
    try {
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
      ]);

      // One-time migration: rename content_models → media_to_text_models.
      // After the rename, drop the stale content_models column if it was re-created.
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
      // Ensure the column exists for fresh installs where the ADD COLUMN above used the old name
      await db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS media_to_text_models JSONB DEFAULT '{}'`;

      // One-time migration: old respond_on booleans → respond_on enum.
      // Only touch rows still at the column default ('mention') whose booleans differ.
      await db.sql`
        UPDATE chats SET respond_on = 'any'
        WHERE respond_on = 'mention' AND respond_on_any = true
      `;
      await db.sql`
        UPDATE chats SET respond_on = 'mention+reply'
        WHERE respond_on = 'mention' AND respond_on_any IS NOT TRUE
          AND respond_on_reply = true AND respond_on_mention IS NOT FALSE
      `;

      // One-time migration: debug_until (timestamp) → debug (boolean).
      // Migrate any active debug_until to debug = true, then drop the old column.
      await db.sql`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='debug_until') THEN
          UPDATE chats SET debug = TRUE WHERE debug_until IS NOT NULL AND debug_until > NOW();
          ALTER TABLE chats DROP COLUMN debug_until;
        END IF;
      END $$`;

      // One-time migration: Claude-specific harness state/config -> generic harness columns.
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
          if (existingHistory.length > 0) continue;
          const legacyHistory = Array.isArray(row.sdk_session_history) ? row.sdk_session_history : [];
          if (legacyHistory.length === 0) continue;
          /** @type {HarnessSessionHistoryEntry[]} */
          const migrated = [];
          for (const rawEntry of legacyHistory) {
            if (!rawEntry || typeof rawEntry !== "object") continue;
            const entry = /** @type {{ id?: unknown, cleared_at?: unknown }} */ (rawEntry);
            if (typeof entry.id !== "string" || typeof entry.cleared_at !== "string") continue;
            migrated.push({
              id: entry.id,
              kind: "claude-sdk",
              cleared_at: entry.cleared_at,
              title: null,
            });
          }
          if (migrated.length > 0) {
            await db.sql`UPDATE chats SET harness_session_history = ${JSON.stringify(migrated)} WHERE chat_id = ${row.chat_id}`;
          }
        }
      }

      await db.sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await Promise.all([
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector`,
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_text tsvector`,
        db.sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS conflicted_files JSONB NOT NULL DEFAULT '[]'`,
        db.sql`ALTER TABLE repos ALTER COLUMN control_chat_id DROP NOT NULL`,
      ]);
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

    /**
     * @param {string} chatId
     * @returns {Promise<void>}
     */
    async function ensureChatExists(chatId) {
      await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING;`;
    }

    /**
     * @param {{
     *   chatId: string,
     *   bindingKind: ChatBindingKind,
     *   repoId?: string | null,
     *   workspaceId?: string | null,
     * }} input
     * @returns {Promise<ChatBindingRow>}
     */
    async function upsertChatBinding({ chatId, bindingKind, repoId = null, workspaceId = null }) {
      await ensureChatExists(chatId);
      const { rows: [row] } = await db.sql`
        INSERT INTO chat_bindings (chat_id, binding_kind, repo_id, workspace_id)
        VALUES (${chatId}, ${bindingKind}, ${repoId}, ${workspaceId})
        ON CONFLICT (chat_id) DO UPDATE SET
          binding_kind = EXCLUDED.binding_kind,
          repo_id = EXCLUDED.repo_id,
          workspace_id = EXCLUDED.workspace_id
        RETURNING *
      `;
      const binding = normalizeChatBindingRow(row);
      if (!binding) {
        throw new Error("Failed to normalize chat binding row");
      }
      return binding;
    }

    return {
      /**
      * @param {ChatRow['chat_id']} chatId
      */
      async getChat (chatId) {
        const { rows: [chat] } = await db.sql`SELECT * FROM chats WHERE chat_id = ${chatId}`;
        return /** @type {ChatRow} */ (chat);
      },

      async closeDb () {
        log.info("Closing database...");
        await db.close();
        log.info("Database closed");
      },

      /**
      * @param {ChatRow['chat_id']} chatId
      * @param {Date} [since] - Only return messages from this time onward (default: 8 hours ago)
      * @param {number} [limit] - Maximum number of messages to return (default: 300)
      */
      // Returns messages in DESC order (newest first); callers reverse for chronological use
      async getMessages (chatId, since = new Date(Date.now() - 8 * 60 * 60 * 1000), limit = 300) {
        const {rows: messages} = await db.sql`SELECT * FROM messages WHERE chat_id = ${chatId} AND cleared_at IS NULL AND timestamp >= ${since} ORDER BY timestamp DESC LIMIT ${limit}`;
        return /** @type {MessageRow[]} */ (messages);
      },

      /**
      * @param {ChatRow['chat_id']} chatId
      */
      async createChat (chatId) {
        await ensureChatExists(chatId);
      },

      /**
       * @param {{
       *   name: string,
       *   rootPath: string,
       *   defaultBaseBranch: string,
       *   controlChatId?: string | null,
       * }} input
       * @returns {Promise<RepoRow>}
       */
      async createRepo ({ name, rootPath, defaultBaseBranch, controlChatId = null }) {
        if (controlChatId) {
          await ensureChatExists(controlChatId);
        }
        const repoId = randomUUID();
        const { rows: [row] } = await db.sql`
          INSERT INTO repos (repo_id, name, root_path, default_base_branch, control_chat_id)
          VALUES (${repoId}, ${name}, ${rootPath}, ${defaultBaseBranch}, ${controlChatId})
          RETURNING *
        `;
        const repo = normalizeRepoRow(row);
        if (!repo) {
          throw new Error("Failed to normalize repo row");
        }
        if (controlChatId) {
          await upsertChatBinding({
            chatId: controlChatId,
            bindingKind: "repo",
            repoId: repo.repo_id,
          });
        }
        return repo;
      },

      /**
       * @param {string} repoId
       * @returns {Promise<RepoRow | null>}
       */
      async getRepo (repoId) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM repos
          WHERE repo_id = ${repoId}
          LIMIT 1
        `;
        return normalizeRepoRow(row);
      },

      /**
       * @param {string} chatId
       * @returns {Promise<RepoRow | null>}
       */
      async getRepoByControlChat (chatId) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM repos
          WHERE control_chat_id = ${chatId}
          LIMIT 1
        `;
        return normalizeRepoRow(row);
      },

      /**
       * @param {string} rootPath
       * @returns {Promise<RepoRow | null>}
       */
      async getRepoByRootPath (rootPath) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM repos
          WHERE root_path = ${rootPath}
          LIMIT 1
        `;
        return normalizeRepoRow(row);
      },

      /**
       * @param {{
       *   repoId: string,
       *   name: string,
       *   branch: string,
       *   baseBranch: string,
       *   worktreePath: string,
       *   workspaceChatId: string,
       *   status?: WorkspaceStatus,
       * }} input
       * @returns {Promise<WorkspaceRow>}
       */
      async createWorkspace ({
        repoId,
        name,
        branch,
        baseBranch,
        worktreePath,
        workspaceChatId,
        status = "ready",
      }) {
        await ensureChatExists(workspaceChatId);
        const workspaceId = randomUUID();
        const { rows: [row] } = await db.sql`
          INSERT INTO workspaces (
            workspace_id,
            repo_id,
            name,
            branch,
            base_branch,
            worktree_path,
            status,
            workspace_chat_id
          )
          VALUES (
            ${workspaceId},
            ${repoId},
            ${name},
            ${branch},
            ${baseBranch},
            ${worktreePath},
            ${status},
            ${workspaceChatId}
          )
          RETURNING *
        `;
        const workspace = normalizeWorkspaceRow(row);
        if (!workspace) {
          throw new Error("Failed to normalize workspace row");
        }
        await upsertChatBinding({
          chatId: workspaceChatId,
          bindingKind: "workspace",
          repoId,
          workspaceId: workspace.workspace_id,
        });
        return workspace;
      },

      /**
       * @param {string} workspaceId
       * @returns {Promise<WorkspaceRow | null>}
       */
      async getWorkspace (workspaceId) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM workspaces
          WHERE workspace_id = ${workspaceId}
          LIMIT 1
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
       * @param {string} chatId
       * @returns {Promise<WorkspaceRow | null>}
       */
      async getWorkspaceByChat (chatId) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM workspaces
          WHERE workspace_chat_id = ${chatId}
          LIMIT 1
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
       * @param {string} repoId
       * @param {string} name
       * @returns {Promise<WorkspaceRow | null>}
       */
      async getWorkspaceByName (repoId, name) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM workspaces
          WHERE repo_id = ${repoId}
            AND name = ${name}
          LIMIT 1
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
       * @param {string} worktreePath
       * @returns {Promise<WorkspaceRow | null>}
       */
      async getWorkspaceByWorktreePath (worktreePath) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM workspaces
          WHERE worktree_path = ${worktreePath}
          LIMIT 1
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
       * @param {string} repoId
       * @returns {Promise<WorkspaceRow[]>}
       */
      async listActiveWorkspaces (repoId) {
        const { rows } = await db.sql`
          SELECT * FROM workspaces
          WHERE repo_id = ${repoId}
            AND archived_at IS NULL
            AND status <> 'archived'
          ORDER BY name
        `;
        return rows
          .map(normalizeWorkspaceRow)
          .filter(/** @returns {row is WorkspaceRow} */ (row) => row !== null);
      },

      /**
       * @param {string} chatId
       * @param {string} repoId
       * @returns {Promise<ChatBindingRow>}
       */
      async bindChatToRepo (chatId, repoId) {
        return upsertChatBinding({
          chatId,
          bindingKind: "repo",
          repoId,
        });
      },

      /**
       * @param {string} chatId
       * @param {string} workspaceId
       * @returns {Promise<ChatBindingRow>}
       */
      async bindChatToWorkspace (chatId, workspaceId) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM workspaces
          WHERE workspace_id = ${workspaceId}
          LIMIT 1
        `;
        const workspace = normalizeWorkspaceRow(row);
        if (!workspace) {
          throw new Error(`Workspace ${workspaceId} does not exist.`);
        }
        return upsertChatBinding({
          chatId,
          bindingKind: "workspace",
          repoId: workspace.repo_id,
          workspaceId,
        });
      },

      /**
       * @param {string} chatId
       * @returns {Promise<ChatBindingRow | null>}
       */
      async getChatBinding (chatId) {
        const { rows: [row] } = await db.sql`
          SELECT * FROM chat_bindings
          WHERE chat_id = ${chatId}
          LIMIT 1
        `;
        return normalizeChatBindingRow(row);
      },

      /**
       * @param {string} workspaceId
       * @returns {Promise<WorkspaceRow | null>}
       */
      async archiveWorkspace (workspaceId) {
        const { rows: [row] } = await db.sql`
          UPDATE workspaces
          SET status = 'archived',
              conflicted_files = '[]'::jsonb,
              archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)
          WHERE workspace_id = ${workspaceId}
          RETURNING *
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
       * @param {string} workspaceId
       * @param {WorkspaceStatus} status
       * @param {{ conflictedFiles?: string[] }} [options]
       * @returns {Promise<WorkspaceRow | null>}
       */
      async setWorkspaceStatus (workspaceId, status, options = {}) {
        const conflictedFiles = options.conflictedFiles ?? [];
        const { rows: [row] } = await db.sql`
          UPDATE workspaces
          SET status = ${status},
              conflicted_files = ${JSON.stringify(conflictedFiles)}::jsonb
          WHERE workspace_id = ${workspaceId}
          RETURNING *
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
       * @param {string} workspaceId
       * @param {WorkspaceRow["last_test_status"]} lastTestStatus
       * @returns {Promise<WorkspaceRow | null>}
       */
      async updateWorkspaceLastTestStatus (workspaceId, lastTestStatus) {
        const { rows: [row] } = await db.sql`
          UPDATE workspaces
          SET last_test_status = ${lastTestStatus}
          WHERE workspace_id = ${workspaceId}
          RETURNING *
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
       * @param {string} workspaceId
       * @param {string | null} lastCommitOid
       * @returns {Promise<WorkspaceRow | null>}
       */
      async updateWorkspaceLastCommitOid (workspaceId, lastCommitOid) {
        const { rows: [row] } = await db.sql`
          UPDATE workspaces
          SET last_commit_oid = ${lastCommitOid}
          WHERE workspace_id = ${workspaceId}
          RETURNING *
        `;
        return normalizeWorkspaceRow(row);
      },

      /**
      * @param {MessageRow['chat_id']} chatId
      * @param {MessageRow['message_data']} message_data
      * @param {MessageRow['sender_id'][]?} senderIds
      * @param {string | null} [displayKey] - Platform message ID of the display message
      */
      async addMessage (chatId, message_data, senderIds = null, displayKey = null) {
        const {rows: [message]} = await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, display_key)
          VALUES (${chatId}, ${senderIds?.join(",")}, ${message_data}, ${displayKey})
          RETURNING *`;
        return /** @type {MessageRow} */ (message);
      },

      /**
       * Update an existing tool message by (chat_id, tool_call_id) JSONB lookup.
       * @param {MessageRow['chat_id']} chatId
       * @param {string} toolCallId
       * @param {ToolMessage} messageData
       * @returns {Promise<MessageRow | null>}
       */
      async updateToolMessage (chatId, toolCallId, messageData) {
        const {rows: [row]} = await db.sql`
          UPDATE messages SET message_data = ${/** @type {Message} */ (messageData)}
          WHERE chat_id = ${chatId}
            AND message_data->>'role' = 'tool'
            AND message_data->>'tool_id' = ${toolCallId}
          RETURNING *`;
        return row ? /** @type {MessageRow} */ (row) : null;
      },

      /**
       * Look up a message row by the platform display key (e.g. for tool-call inspect).
       * @param {MessageRow['chat_id']} chatId
       * @param {string} displayKey
       * @returns {Promise<MessageRow | null>}
       */
      async getMessageByDisplayKey (chatId, displayKey) {
        const {rows: [row]} = await db.sql`
          SELECT * FROM messages
          WHERE chat_id = ${chatId}
            AND display_key = ${displayKey}
          LIMIT 1`;
        return row ? /** @type {MessageRow} */ (row) : null;
      },

      /**
       * Save the current harness session for a chat, or clear it when null.
       * @param {ChatRow['chat_id']} chatId
       * @param {HarnessSessionRef | null} session
       */
      async saveHarnessSession (chatId, session) {
        await db.sql`
          UPDATE chats
          SET harness_session_id = ${session?.id ?? null},
              harness_session_kind = ${session?.kind ?? null}
          WHERE chat_id = ${chatId}
        `;
      },

      /**
       * Archive the current harness session into the session history.
       * Does nothing if there is no current session.
       * Keeps at most `maxEntries` entries (oldest are dropped).
       * @param {ChatRow['chat_id']} chatId
       * @param {{ maxEntries?: number, title?: string | null }} [options]
       * @returns {Promise<HarnessSessionHistoryEntry | null>}
       */
      async archiveHarnessSession (chatId, options = {}) {
        const maxEntries = options.maxEntries ?? 10;
        const { rows: [row] } = await db.sql`
          SELECT harness_session_id, harness_session_kind, harness_session_history
          FROM chats WHERE chat_id = ${chatId}
        `;
        const chat = /** @type {Pick<ChatRow, 'harness_session_id' | 'harness_session_kind' | 'harness_session_history'>} */ (row);
        if (!chat?.harness_session_id || !chat?.harness_session_kind) return null;

        const history = normalizeHarnessSessionHistory(chat.harness_session_history);

        // Avoid duplicates
        if (history.some(e => e.id === chat.harness_session_id && e.kind === chat.harness_session_kind)) {
          return null;
        }

        /** @type {HarnessSessionHistoryEntry} */
        const entry = {
          id: chat.harness_session_id,
          kind: chat.harness_session_kind,
          cleared_at: new Date().toISOString(),
          title: typeof options.title === "string" && options.title.trim() ? options.title.trim() : null,
        };
        const updated = [...history, entry].slice(-maxEntries);

        await db.sql`
          UPDATE chats
          SET harness_session_history = ${JSON.stringify(updated)},
              harness_session_id = NULL,
              harness_session_kind = NULL
          WHERE chat_id = ${chatId}
        `;
        return entry;
      },

      /**
       * Get the harness session history for a chat.
       * @param {ChatRow['chat_id']} chatId
       * @returns {Promise<HarnessSessionHistoryEntry[]>}
       */
      async getHarnessSessionHistory (chatId) {
        const { rows: [row] } = await db.sql`SELECT harness_session_history FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'harness_session_history'> | undefined} */ (row);
        if (!chat) return [];
        return normalizeHarnessSessionHistory(chat.harness_session_history);
      },

      /**
       * Restore a session from history by index (0 = most recent) or session ID.
       * Removes it from history and sets it as the active session.
       * Caller should call `archiveHarnessSession` first to save any active session.
       * @param {ChatRow['chat_id']} chatId
       * @param {number | string} indexOrId - 0-based index from the end (most recent = 0) or a session ID string
       * @returns {Promise<HarnessSessionHistoryEntry | null>} The restored entry, or null if not found
       */
      async restoreHarnessSession (chatId, indexOrId) {
        const { rows: [row] } = await db.sql`SELECT harness_session_history FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'harness_session_history'> | undefined} */ (row);
        if (!chat) return null;

        const history = normalizeHarnessSessionHistory(chat.harness_session_history);
        if (history.length === 0) return null;

        /** @type {number} */
        let idx;
        if (typeof indexOrId === "number") {
          // 0 = most recent (last entry)
          idx = history.length - 1 - indexOrId;
        } else {
          idx = history.findIndex(e => e.id === indexOrId);
        }

        if (idx < 0 || idx >= history.length) return null;

        const entry = history[idx];
        // Remove the restored entry from history
        history.splice(idx, 1);

        await db.sql`
          UPDATE chats
          SET harness_session_id = ${entry.id},
              harness_session_kind = ${entry.kind},
              harness_session_history = ${JSON.stringify(history)}
          WHERE chat_id = ${chatId}
        `;
        return entry;
      },

      /**
       * Get the persisted harness fork stack for a chat.
       * @param {ChatRow['chat_id']} chatId
       * @returns {Promise<HarnessForkStackEntry[]>}
       */
      async getHarnessForkStack (chatId) {
        const { rows: [row] } = await db.sql`SELECT harness_fork_stack FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'harness_fork_stack'> | undefined} */ (row);
        if (!chat) return [];
        return normalizeHarnessForkStack(chat.harness_fork_stack);
      },

      /**
       * Push one parent session reference onto the harness fork stack.
       * @param {ChatRow['chat_id']} chatId
       * @param {HarnessForkStackEntry} entry
       * @returns {Promise<void>}
       */
      async pushHarnessForkStack (chatId, entry) {
        const { rows: [row] } = await db.sql`SELECT harness_fork_stack FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'harness_fork_stack'> | undefined} */ (row);
        const stack = normalizeHarnessForkStack(chat?.harness_fork_stack);
        const normalizedEntry = normalizeHarnessForkStackEntry(entry);
        if (!normalizedEntry) {
          throw new Error("Invalid harness fork stack entry");
        }
        await db.sql`
          UPDATE chats
          SET harness_fork_stack = ${JSON.stringify([...stack, normalizedEntry])}
          WHERE chat_id = ${chatId}
        `;
      },

      /**
       * Pop the most recent parent session reference from the harness fork stack.
       * @param {ChatRow['chat_id']} chatId
       * @returns {Promise<HarnessForkStackEntry | null>}
       */
      async popHarnessForkStack (chatId) {
        const { rows: [row] } = await db.sql`SELECT harness_fork_stack FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'harness_fork_stack'> | undefined} */ (row);
        const stack = normalizeHarnessForkStack(chat?.harness_fork_stack);
        const entry = stack.pop() ?? null;
        await db.sql`
          UPDATE chats
          SET harness_fork_stack = ${JSON.stringify(stack)}
          WHERE chat_id = ${chatId}
        `;
        return entry;
      },
    }
}

/** @typedef {Awaited<ReturnType<typeof initStore>>} Store */
