/**
 * Persistence layer for pending confirmations.
 * Stores confirmation state in the DB so they survive bot restarts.
 */

/**
 * @typedef {{
 *   id: number;
 *   chat_id: string;
 *   msg_key_id: string;
 *   msg_key_remote_jid: string;
 *   action_name: string;
 *   action_params: Record<string, unknown>;
 *   tool_call_id: string | null;
 *   sender_ids: string[];
 *   created_at: string;
 * }} PendingConfirmationRow
 */

/**
 * Create the pending_confirmations table if it doesn't exist.
 * @param {PGlite} db
 */
export async function initPendingConfirmationsTable(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      msg_key_id TEXT NOT NULL UNIQUE,
      msg_key_remote_jid TEXT NOT NULL,
      action_name TEXT NOT NULL,
      action_params JSONB NOT NULL DEFAULT '{}',
      tool_call_id TEXT,
      sender_ids TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

/**
 * Save a pending confirmation to the DB.
 * Uses ON CONFLICT to overwrite if the same msg_key_id already exists.
 * @param {PGlite} db
 * @param {{
 *   chatId: string;
 *   msgKeyId: string;
 *   msgKeyRemoteJid: string;
 *   actionName: string;
 *   actionParams: Record<string, unknown>;
 *   toolCallId: string | null;
 *   senderIds: string[];
 * }} params
 */
export async function savePendingConfirmation(db, {
  chatId, msgKeyId, msgKeyRemoteJid, actionName, actionParams, toolCallId, senderIds,
}) {
  await db.sql`
    INSERT INTO pending_confirmations
      (chat_id, msg_key_id, msg_key_remote_jid, action_name, action_params, tool_call_id, sender_ids)
    VALUES (${chatId}, ${msgKeyId}, ${msgKeyRemoteJid}, ${actionName}, ${JSON.stringify(actionParams)}::jsonb, ${toolCallId}, ${senderIds})
    ON CONFLICT (msg_key_id) DO UPDATE SET
      action_name = EXCLUDED.action_name,
      action_params = EXCLUDED.action_params,
      tool_call_id = EXCLUDED.tool_call_id,
      sender_ids = EXCLUDED.sender_ids,
      created_at = NOW()
  `;
}

/**
 * Delete a pending confirmation by its message key ID.
 * @param {PGlite} db
 * @param {string} msgKeyId
 */
export async function deletePendingConfirmation(db, msgKeyId) {
  await db.sql`DELETE FROM pending_confirmations WHERE msg_key_id = ${msgKeyId}`;
}

/**
 * Load all pending confirmations from the DB.
 * @param {PGlite} db
 * @returns {Promise<PendingConfirmationRow[]>}
 */
export async function loadPendingConfirmations(db) {
  const { rows } = await db.sql`SELECT * FROM pending_confirmations ORDER BY created_at ASC`;
  return /** @type {PendingConfirmationRow[]} */ (rows);
}
