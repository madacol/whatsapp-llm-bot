/**
 * Create the minimal root schema required before legacy migrations can run.
 * @param {PGlite} db
 * @returns {Promise<void>}
 */
export async function bootstrapStoreSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id VARCHAR(50) PRIMARY KEY,
      is_enabled BOOLEAN DEFAULT FALSE,
      system_prompt TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
}
