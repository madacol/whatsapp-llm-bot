/**
 * Create and migrate the per-chat schema used for chat-owned state.
 * @param {import("../../sqlite-db.js").SqliteDb} db
 * @returns {Promise<void>}
 */
export async function ensureChatStoreSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id TEXT PRIMARY KEY,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      sender_id TEXT,
      message_data TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      cleared_at TEXT,
      exchange_text TEXT,
      llm_context TEXT,
      display_key TEXT,
      embedding TEXT,
      search_text TEXT
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      content TEXT NOT NULL,
      embedding TEXT,
      search_text TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      reminder_text TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      delivered INTEGER DEFAULT 0
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      parent_tool_call_id TEXT,
      agent_name TEXT NOT NULL,
      messages TEXT NOT NULL,
      usage TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS whatsapp_outbound_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`CREATE INDEX IF NOT EXISTS idx_messages_display_key ON messages (chat_id, display_key) WHERE display_key IS NOT NULL`;
  await db.sql`CREATE INDEX IF NOT EXISTS idx_memories_chat_id_created_at ON memories (chat_id, created_at)`;
  await db.sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_queue_chat_id_id ON whatsapp_outbound_queue (chat_id, id)`;
}
