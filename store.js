import { getDb } from "./db.js";

// Initialize database
const db = getDb("./pgdata/root");

/**
 * @typedef {{
 *   chat_id: string;
 *   is_enabled: boolean;
 *   system_prompt: string;
 *   timestamp: string;
 * }} ChatRow
 *
 * @typedef {{
 *   message_id: number;
 *   chat_id: string;
 *   sender_id: string;
 *   message_data: Message;
 *   timestamp: Date;
 * }} MessageRow
 */

export async function initDatabase(){
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
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // Add new columns if they don't exist (for existing databases)
    try {
      await Promise.any([
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT FALSE`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS system_prompt TEXT`,
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_data JSONB`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS message_type VARCHAR(20) DEFAULT 'user'`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_call_id VARCHAR(100)`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_name VARCHAR(100)`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_args TEXT`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS content JSONB`,
      ]);
    } catch (error) {
      // Ignore errors if columns already exist
      console.log("Database schema already up to date");
    }
}

/**
 * @param {ChatRow['chat_id']} chatId
 */
export async function getChat (chatId) {
  const { rows: [chat] } = await db.sql`SELECT * FROM chats WHERE chat_id = ${chatId}`;
  return /** @type {ChatRow} */ (chat);
};

export function closeDb () { return db.close()};

/**
 * @param {ChatRow['chat_id']} chatId
 * @param {number} limit
 */
export async function getMessages (chatId, limit = 50) {
  const {rows: messages} = await db.sql`SELECT * FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT ${limit}`;
  // messages.message_data = JSON.parse(messages.message_data);
  return /** @type {MessageRow[]} */ (messages);
};

/**
 * @param {ChatRow['chat_id']} chatId
 */
export async function createChat (chatId) {
  await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING;`;
};

/**
 * @param {MessageRow['chat_id']} chatId
 * @param {MessageRow['message_data']} message_data
 * @param {MessageRow['sender_id']} senderId
 */
export async function addMessage (chatId, message_data, senderId = null) {
  const {rows: [message]} = await db.sql`INSERT INTO messages(chat_id, sender_id, message_data)
    VALUES (${chatId}, ${senderId}, ${message_data})
    RETURNING *`;
  return /** @type {MessageRow} */ (message);
};
