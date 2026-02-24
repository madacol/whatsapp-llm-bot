import { getChatOrThrow } from "../store.js";

/**
 * Shared helper for enableChat and disableChat actions.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {boolean} enabled
 * @returns {Promise<string>}
 */
export async function setChatEnabled(rootDb, chatId, enabled) {
  await getChatOrThrow(rootDb, chatId);

  await rootDb.sql`
    UPDATE chats
    SET is_enabled = ${enabled}
    WHERE chat_id = ${chatId}
  `;

  return `Bot ${enabled ? "enabled" : "disabled"}.`;
}
