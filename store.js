import { getDb } from "./db.js";

/**
 * @typedef {{
 *   chat_id: string;
 *   is_enabled: boolean;
 *   system_prompt: string;
 *   model: string;
 *   respond_on_any: boolean;
 *   respond_on_mention: boolean;
 *   respond_on_reply: boolean;
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

/**
 * @param {PGlite} [injectedDb]
 */
export async function initStore(injectedDb){
    // Initialize database
    const db = injectedDb || getDb("./pgdata/root");

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
      await Promise.all([
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT FALSE`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS system_prompt TEXT`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_any BOOLEAN DEFAULT FALSE`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_mention BOOLEAN DEFAULT TRUE`,
        db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS respond_on_reply BOOLEAN DEFAULT FALSE`,
        db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_data JSONB`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS message_type`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_call_id`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_name`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS tool_args`,
        db.sql`ALTER TABLE messages DROP COLUMN IF EXISTS content`,
      ]);
    } catch (error) {
      // Ignore errors if columns already exist
      console.log("Database schema already up to date");
    }
    return {
      /**
      * @param {ChatRow['chat_id']} chatId
      */
      async getChat (chatId) {
        const { rows: [chat] } = await db.sql`SELECT * FROM chats WHERE chat_id = ${chatId}`;
        return /** @type {ChatRow} */ (chat);
      },

      closeDb () {
        console.log("Closing database...");
        return db.close();
        console.log("Database closed");
      },

      /**
      * @param {ChatRow['chat_id']} chatId
      * @param {number} limit
      */
      async getMessages (chatId, limit = 50) {
        const {rows: messages} = await db.sql`SELECT * FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT ${limit}`;
        // messages.message_data = JSON.parse(messages.message_data);
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
    }
}
