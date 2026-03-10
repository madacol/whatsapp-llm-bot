import { getRootDb } from "./db.js";
import { initPendingConfirmationsTable } from "./pending-confirmations.js";
import { createLogger } from "./logger.js";

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
 *   debug_until: string | null;
 *   media_to_text_models: { image?: string, audio?: string, video?: string, general?: string };
 *   model_roles: Record<string, string>;
 *   memory: boolean;
 *   memory_threshold: number | null;
 *   enabled_actions: string[];
 *   active_persona: string | null;
 *   harness: string | null;
 *   harness_cwd: string | null;
 *   sdk_session_id: string | null;
 *   sdk_session_history: SdkSessionHistoryEntry[];
 *   timestamp: string;
 * }} ChatRow
 *
 * @typedef {{
 *   id: string;
 *   cleared_at: string;
 * }} SdkSessionHistoryEntry
 *
 * @typedef {{
 *   message_id: number;
 *   chat_id: string;
 *   sender_id: string; // Comma-separated sender IDs (e.g. "phone_id,lid_id")
 *   message_data: Message;
 *   timestamp: Date;
 * }} MessageRow
 */

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
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS debug_until TIMESTAMP`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS content_models JSONB DEFAULT '{}'`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS memory BOOLEAN DEFAULT FALSE`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS memory_threshold REAL`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on TEXT DEFAULT 'mention'`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS enabled_actions JSONB DEFAULT '[]'`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS model_roles JSONB DEFAULT '{}'`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS active_persona TEXT`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness TEXT`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS harness_cwd TEXT`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS sdk_session_id TEXT`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS sdk_session_history JSONB DEFAULT '[]'`,
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS exchange_text TEXT`,
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS llm_context JSONB`,
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

      await db.sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await Promise.all([
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector`,
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_text tsvector`,
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
      await db.sql`CREATE INDEX IF NOT EXISTS idx_memories_search_text ON memories USING gin (search_text)`;
      await db.sql`CREATE INDEX IF NOT EXISTS idx_messages_wa_key_id ON messages ((message_data->>'wa_key_id')) WHERE message_data->>'wa_key_id' IS NOT NULL`;
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
      await initPendingConfirmationsTable(db);
    } catch (error) {
      log.error("⚠️ SCHEMA MIGRATION FAILED — the database may be in an inconsistent state!", error);
      log.error("⚠️ Review the error above and fix manually if needed. The bot will continue but may malfunction.");
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
        await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING;`;
      },

      /**
      * @param {MessageRow['chat_id']} chatId
      * @param {MessageRow['message_data']} message_data
      * @param {MessageRow['sender_id'][]?} senderIds
      */
      async addMessage (chatId, message_data, senderIds = null) {
        const {rows: [message]} = await db.sql`INSERT INTO messages(chat_id, sender_id, message_data)
          VALUES (${chatId}, ${senderIds?.join(",")}, ${message_data})
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
          UPDATE messages SET message_data = ${/** @type {*} */ (messageData)}
          WHERE chat_id = ${chatId}
            AND message_data->>'role' = 'tool'
            AND message_data->>'tool_id' = ${toolCallId}
          RETURNING *`;
        return row ? /** @type {MessageRow} */ (row) : null;
      },

      /**
       * Look up a tool result message by its WhatsApp message key ID.
       * Used by the reaction handler for "react to inspect" tool results.
       * WA message key IDs are globally unique, so no chat_id filter needed.
       * @param {string} waKeyId
       * @returns {Promise<{ toolMsg: ToolMessage; chatId: string } | null>}
       */
      async getToolResultByWaKeyId (waKeyId) {
        const { rows: [row] } = await db.sql`
          SELECT chat_id, message_data FROM messages
          WHERE message_data->>'role' = 'tool'
            AND message_data->>'wa_key_id' = ${waKeyId}
          ORDER BY timestamp DESC LIMIT 1`;
        return row
          ? { toolMsg: /** @type {ToolMessage} */ (/** @type {MessageRow} */ (row).message_data), chatId: /** @type {MessageRow} */ (row).chat_id }
          : null;
      },

      /**
       * Update the SDK session ID for a chat (used by claude-agent-sdk harness for session resumption).
       * @param {ChatRow['chat_id']} chatId
       * @param {string | null} sessionId
       */
      async updateSdkSessionId (chatId, sessionId) {
        await db.sql`UPDATE chats SET sdk_session_id = ${sessionId} WHERE chat_id = ${chatId}`;
      },

      /**
       * Archive the current SDK session ID into the session history.
       * Does nothing if there is no current session.
       * Keeps at most `maxEntries` entries (oldest are dropped).
       * @param {ChatRow['chat_id']} chatId
       * @param {number} [maxEntries=10]
       */
      async archiveSdkSession (chatId, maxEntries = 10) {
        const { rows: [row] } = await db.sql`SELECT sdk_session_id, sdk_session_history FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'sdk_session_id' | 'sdk_session_history'>} */ (row);
        if (!chat?.sdk_session_id) return;

        /** @type {SdkSessionHistoryEntry[]} */
        const history = Array.isArray(chat.sdk_session_history) ? chat.sdk_session_history : [];

        // Avoid duplicates
        if (history.some(e => e.id === chat.sdk_session_id)) return;

        /** @type {SdkSessionHistoryEntry} */
        const entry = { id: chat.sdk_session_id, cleared_at: new Date().toISOString() };
        const updated = [...history, entry].slice(-maxEntries);

        await db.sql`UPDATE chats SET sdk_session_history = ${JSON.stringify(updated)}, sdk_session_id = NULL WHERE chat_id = ${chatId}`;
      },

      /**
       * Get the SDK session history for a chat.
       * @param {ChatRow['chat_id']} chatId
       * @returns {Promise<SdkSessionHistoryEntry[]>}
       */
      async getSdkSessionHistory (chatId) {
        const { rows: [row] } = await db.sql`SELECT sdk_session_history FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'sdk_session_history'> | undefined} */ (row);
        if (!chat) return [];
        return Array.isArray(chat.sdk_session_history) ? chat.sdk_session_history : [];
      },

      /**
       * Restore a session from history by index (0 = most recent) or session ID.
       * Removes it from history and sets it as the active session.
       * Caller should call `archiveSdkSession` first to save any active session.
       * @param {ChatRow['chat_id']} chatId
       * @param {number | string} indexOrId - 0-based index from the end (most recent = 0) or a session ID string
       * @returns {Promise<SdkSessionHistoryEntry | null>} The restored entry, or null if not found
       */
      async restoreSdkSession (chatId, indexOrId) {
        const { rows: [row] } = await db.sql`SELECT sdk_session_history FROM chats WHERE chat_id = ${chatId}`;
        const chat = /** @type {Pick<ChatRow, 'sdk_session_history'> | undefined} */ (row);
        if (!chat) return null;

        /** @type {SdkSessionHistoryEntry[]} */
        const history = Array.isArray(chat.sdk_session_history) ? chat.sdk_session_history : [];
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

        await db.sql`UPDATE chats SET sdk_session_id = ${entry.id}, sdk_session_history = ${JSON.stringify(history)} WHERE chat_id = ${chatId}`;
        return entry;
      },
    }
}

/** @typedef {Awaited<ReturnType<typeof initStore>>} Store */
