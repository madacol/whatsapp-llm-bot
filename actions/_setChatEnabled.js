/**
 * Shared helper for enableChat and disableChat actions.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @param {boolean} enabled
 * @returns {Promise<string>}
 */
export async function setChatEnabled(rootDb, chatId, enabled) {
  const {
    rows: [chatExists],
  } = await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

  if (!chatExists) {
    throw new Error(`Chat ${chatId} does not exist.`);
  }

  try {
    await rootDb.sql`
      UPDATE chats
      SET is_enabled = ${enabled}
      WHERE chat_id = ${chatId}
    `;

    const status = enabled ? "enabled" : "disabled";
    return `Bot ${status}.`;
  } catch (error) {
    const status = enabled ? "enable" : "disable";
    console.error(`Error ${status === "enable" ? "enabling" : "disabling"} chat:`, error);
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to ${status} chat: ${errorMessage}`);
  }
}
