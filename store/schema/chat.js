/**
 * Create and migrate the per-chat schema used for chat-owned state.
 * @param {PGlite} db
 * @returns {Promise<void>}
 */
export async function ensureChatStoreSchema(db) {
  await db.sql`CREATE EXTENSION IF NOT EXISTS vector`;

  await db.sql`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id VARCHAR(50) PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS messages (
      message_id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50),
      sender_id VARCHAR(50),
      message_data JSONB,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      cleared_at TIMESTAMP,
      exchange_text TEXT,
      llm_context JSONB,
      display_key TEXT,
      embedding vector,
      search_text tsvector
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50),
      content TEXT NOT NULL,
      embedding vector,
      search_text tsvector,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      reminder_text TEXT NOT NULL,
      remind_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      delivered BOOLEAN DEFAULT FALSE
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50) NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost DOUBLE PRECISION,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50),
      parent_tool_call_id TEXT,
      agent_name TEXT NOT NULL,
      messages JSONB NOT NULL,
      usage JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`
    CREATE TABLE IF NOT EXISTS whatsapp_outbound_queue (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50) NOT NULL,
      payload_json JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.sql`CREATE INDEX IF NOT EXISTS idx_messages_search_text ON messages USING gin (search_text)`;
  await db.sql`CREATE INDEX IF NOT EXISTS idx_messages_display_key ON messages (chat_id, display_key) WHERE display_key IS NOT NULL`;
  await db.sql`CREATE INDEX IF NOT EXISTS idx_memories_search_text ON memories USING gin (search_text)`;
  await db.sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_queue_chat_id_id ON whatsapp_outbound_queue (chat_id, id)`;
}
