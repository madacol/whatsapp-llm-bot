import { normalizeMessageRow } from "../normalizers.js";

/** @typedef {import("../../store.js").Store} Store */
/** @typedef {import("../../store.js").MessageRow} MessageRow */

/**
 * @typedef {{
 *   db: PGlite;
 * }} MessageStoreDeps
 */

/**
 * Build message store methods.
 * @param {MessageStoreDeps} deps
 * @returns {Pick<Store, "getMessages" | "addMessage" | "updateToolMessage" | "getMessageByDisplayKey">}
 */
export function createMessageStore({ db }) {
  return {
    /**
     * Returns messages in DESC order (newest first); callers reverse for chronological use.
     * @param {MessageRow["chat_id"]} chatId
     * @param {Date} [since]
     * @param {number} [limit]
     * @returns {Promise<MessageRow[]>}
     */
    async getMessages(chatId, since = new Date(Date.now() - 8 * 60 * 60 * 1000), limit = 300) {
      const { rows } = await db.sql`
        SELECT * FROM messages
        WHERE chat_id = ${chatId}
          AND cleared_at IS NULL
          AND timestamp >= ${since}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
      return rows
        .map(normalizeMessageRow)
        .filter(/** @returns {row is MessageRow} */ (row) => row !== null);
    },

    /**
     * @param {MessageRow["chat_id"]} chatId
     * @param {MessageRow["message_data"]} messageData
     * @param {string[]?} senderIds
     * @param {string | null} [displayKey]
     * @returns {Promise<MessageRow>}
     */
    async addMessage(chatId, messageData, senderIds = null, displayKey = null) {
      const { rows: [row] } = await db.sql`
        INSERT INTO messages(chat_id, sender_id, message_data, display_key)
        VALUES (${chatId}, ${senderIds?.join(",") ?? null}, ${messageData}, ${displayKey})
        RETURNING *
      `;
      const message = normalizeMessageRow(row);
      if (!message) {
        throw new Error(`Failed to normalize message row for chat ${chatId}.`);
      }
      return message;
    },

    /**
     * @param {MessageRow["chat_id"]} chatId
     * @param {string} toolCallId
     * @param {ToolMessage} messageData
     * @returns {Promise<MessageRow | null>}
     */
    async updateToolMessage(chatId, toolCallId, messageData) {
      const { rows: [row] } = await db.sql`
        UPDATE messages
        SET message_data = ${/** @type {Message} */ (messageData)}
        WHERE chat_id = ${chatId}
          AND message_data->>'role' = 'tool'
          AND message_data->>'tool_id' = ${toolCallId}
        RETURNING *
      `;
      return normalizeMessageRow(row);
    },

    /**
     * @param {MessageRow["chat_id"]} chatId
     * @param {string} displayKey
     * @returns {Promise<MessageRow | null>}
     */
    async getMessageByDisplayKey(chatId, displayKey) {
      const { rows: [row] } = await db.sql`
        SELECT * FROM messages
        WHERE chat_id = ${chatId}
          AND display_key = ${displayKey}
        LIMIT 1
      `;
      return normalizeMessageRow(row);
    },
  };
}
