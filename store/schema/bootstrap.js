/**
 * Create the minimal root schema required before root migrations can run.
 * @param {import("../../sqlite-db.js").SqliteDb} db
 * @returns {Promise<void>}
 */
export async function bootstrapStoreSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id VARCHAR(50) PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
}
