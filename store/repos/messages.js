import { normalizeMessageRow } from "../normalizers.js";

/** @typedef {import("../../store.js").Store} Store */
/** @typedef {import("../../store.js").MessageRow} MessageRow */

const POSTGRES_UNSUPPORTED_NUL = /\u0000/g;

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
      const sanitizedMessageData = sanitizeMessageDataForJsonb(messageData);
      const { rows: [row] } = await db.sql`
        INSERT INTO messages(chat_id, sender_id, message_data, display_key)
        VALUES (${chatId}, ${senderIds?.join(",") ?? null}, ${sanitizedMessageData}, ${displayKey})
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
      const sanitizedMessageData = sanitizeToolMessageForJsonb(messageData);
      const { rows: [row] } = await db.sql`
        UPDATE messages
        SET message_data = ${sanitizedMessageData}
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Postgres JSONB rejects U+0000 inside string values. Preserve the visible
 * marker as two printable characters so tool output can still explain paths
 * like Rollup's `\0virtual:*` module ids.
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeJsonbValue(value) {
  if (typeof value === "string") {
    return value.replace(POSTGRES_UNSUPPORTED_NUL, "\\0");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonbValue(entry));
  }
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeJsonbValue(entry);
    }
    return sanitized;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Message}
 */
function isMessage(value) {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return false;
  }
  if (value.role === "user" || value.role === "assistant") {
    return true;
  }
  return value.role === "tool" && typeof value.tool_id === "string";
}

/**
 * @param {unknown} value
 * @returns {value is ToolMessage}
 */
function isToolMessage(value) {
  return isRecord(value)
    && value.role === "tool"
    && typeof value.tool_id === "string"
    && Array.isArray(value.content);
}

/**
 * @param {Message} messageData
 * @returns {Message}
 */
function sanitizeMessageDataForJsonb(messageData) {
  const sanitized = sanitizeJsonbValue(messageData);
  if (!isMessage(sanitized)) {
    throw new Error("Message sanitizer produced an invalid message shape.");
  }
  return sanitized;
}

/**
 * @param {ToolMessage} messageData
 * @returns {ToolMessage}
 */
function sanitizeToolMessageForJsonb(messageData) {
  const sanitized = sanitizeJsonbValue(messageData);
  if (!isToolMessage(sanitized)) {
    throw new Error("Message sanitizer produced an invalid tool message shape.");
  }
  return sanitized;
}
