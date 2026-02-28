import { getRootDb } from "./db.js";
import { ensureSchema } from "./actions/tools/reminders.js";
import { createDaemon } from "./daemon.js";
import { createLogger } from "./logger.js";

const log = createLogger("reminder-daemon");

/**
 * Poll for due reminders and deliver them.
 * Exported separately for testing.
 * @param {PGlite} db
 * @param {(chatId: string, text: string) => Promise<void>} sendToChat
 */
export async function pollReminders(db, sendToChat) {
  const { rows } = await db.sql`
    SELECT id, chat_id, reminder_text, remind_at
    FROM reminders
    WHERE remind_at <= NOW() AND delivered = FALSE
  `;

  for (const reminder of rows) {
    const text = `🔔 *Reminder*\n\n${reminder.reminder_text}`;
    try {
      await sendToChat(/** @type {string} */ (reminder.chat_id), text);
      await db.sql`UPDATE reminders SET delivered = TRUE WHERE id = ${reminder.id}`;
    } catch (error) {
      log.error(`Failed to deliver reminder #${reminder.id}:`, error);
    }
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
    init: () => ensureSchema(db),
    poll: () => pollReminders(db, sendToChat),
    intervalMs: POLL_INTERVAL_MS,
    label: "Reminder daemon",
  });
}
