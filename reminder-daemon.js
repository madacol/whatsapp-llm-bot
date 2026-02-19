import { getDb } from "./db.js";
import { ensureSchema } from "./actions/reminders.js";

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
      console.error(`Failed to deliver reminder #${reminder.id}:`, error);
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
  const db = getDb("./pgdata/root");

  // Ensure schema on startup (async, but non-blocking for the interval)
  ensureSchema(db).catch((err) =>
    console.error("Failed to ensure reminders schema:", err),
  );

  const interval = setInterval(async () => {
    try {
      await pollReminders(db, sendToChat);
    } catch (error) {
      console.error("Reminder daemon poll error:", error);
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}
