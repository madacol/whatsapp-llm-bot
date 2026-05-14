import { getChatDb, getRootDb } from "./db.js";
import { createDaemon } from "./daemon.js";
import { createLogger } from "./logger.js";
import { isSqliteDb } from "./sqlite-db.js";
import { ensureChatStoreSchema } from "./store/schema/chat.js";

const log = createLogger("reminder-daemon");

/**
 * Poll one chat DB for due reminders and deliver them.
 * Exported separately for testing.
 * @param {PGlite | import("./sqlite-db.js").SqliteDb} db
 * @param {(chatId: string, text: string) => Promise<void>} sendToChat
 */
export async function pollChatReminders(db, sendToChat) {
  const { rows } = isSqliteDb(db)
    ? await db.sql`
      SELECT id, chat_id, reminder_text, remind_at
      FROM reminders
      WHERE remind_at <= ${new Date().toISOString()} AND delivered = ${false}
    `
    : await db.sql`
      SELECT id, chat_id, reminder_text, remind_at
      FROM reminders
      WHERE remind_at <= NOW() AND delivered = FALSE
    `;

  for (const reminder of rows) {
    const text = `🔔 *Reminder*\n\n${reminder.reminder_text}`;
    try {
      await sendToChat(/** @type {string} */ (reminder.chat_id), text);
      await db.sql`UPDATE reminders SET delivered = ${true} WHERE id = ${reminder.id}`;
    } catch (error) {
      log.error(`Failed to deliver reminder #${reminder.id}:`, error);
    }
  }
}

/**
 * Poll all registered chat DBs for due reminders.
 * @param {PGlite} rootDb
 * @param {(chatId: string, text: string) => Promise<void>} sendToChat
 * @returns {Promise<void>}
 */
export async function pollReminders(rootDb, sendToChat) {
  const { rows } = await rootDb.sql`SELECT chat_id FROM chats ORDER BY chat_id`;
  if (rows.length === 0) {
    await pollChatReminders(rootDb, sendToChat);
    return;
  }
  for (const row of rows) {
    if (typeof row.chat_id !== "string") {
      continue;
    }
    const chatDb = getChatDb(row.chat_id);
    await ensureChatStoreSchema(chatDb);
    await pollChatReminders(chatDb, sendToChat);
  }
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Start the reminder polling daemon.
 * @param {(chatId: string, text: string) => Promise<void>} sendToChat
 * @returns {() => void} Stop function to clear the interval
 */
export function startReminderDaemon(sendToChat) {
  const db = getRootDb();

  return createDaemon({
    init: async () => {},
    poll: () => pollReminders(db, sendToChat),
    intervalMs: POLL_INTERVAL_MS,
    label: "Reminder daemon",
  });
}
