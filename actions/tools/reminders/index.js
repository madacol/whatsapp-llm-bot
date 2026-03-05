
/**
 * Ensure the reminders schema exists.
 * @param {PGlite} db
 */
export async function ensureSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      reminder_text TEXT NOT NULL,
      remind_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      delivered BOOLEAN DEFAULT FALSE
    )
  `;
}

import { formatTime } from "../../../utils.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_reminder",
  command: "remind",
  description:
    "Set, list, or cancel reminders. The bot will send a message at the specified time. Use natural language to describe when (e.g. 'in 2 hours', 'tomorrow at 9am'). The LLM converts this to an ISO 8601 timestamp.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action to perform",
        enum: ["set", "list", "cancel"],
      },
      reminder_text: {
        type: "string",
        description: "What to remind about (required for 'set')",
      },
      remind_at: {
        type: "string",
        description:
          "ISO 8601 timestamp for when to send the reminder (required for 'set'). The LLM should extract this from natural language.",
      },
      reminder_id: {
        type: "string",
        description: "ID of the reminder to cancel (required for 'cancel')",
      },
    },
    required: ["action"],
  },
  formatToolCall: ({ action, reminder_text }) => {
    if (action === "list") return "Listing reminders";
    if (action === "cancel") return "Cancelling reminder";
    if (action === "set" && reminder_text) {
      const short = reminder_text.length > 40 ? reminder_text.slice(0, 40) + "…" : reminder_text;
      return `Setting reminder: "${short}"`;
    }
    return "Setting reminder";
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
  },
  /**
   * @param {ExtendedActionContext<{autoExecute: true, autoContinue: true, useRootDb: true}>} context
   * @param {{action: "set"|"list"|"cancel", reminder_text?: string, remind_at?: string, reminder_id?: string}} params
   */
  action_fn: async function (context, params) {
    const { rootDb, chatId } = context;

    await ensureSchema(rootDb);

    if (params.action === "set") {
      if (!params.reminder_text) {
        return "Please specify what to remind you about (reminder_text).";
      }
      if (!params.remind_at) {
        return "Please specify when to send the reminder (remind_at as ISO 8601 timestamp).";
      }

      const remindAt = new Date(params.remind_at);
      if (isNaN(remindAt.getTime())) {
        return "Invalid date format. Please use an ISO 8601 timestamp.";
      }
      if (remindAt.getTime() <= Date.now()) {
        return "The reminder time must be in the future.";
      }

      const { rows } = await rootDb.sql`
        INSERT INTO reminders (chat_id, reminder_text, remind_at)
        VALUES (${chatId}, ${params.reminder_text}, ${remindAt.toISOString()})
        RETURNING id
      `;

      return `Reminder #${rows[0].id}: "${params.reminder_text}" at ${formatTime(remindAt)}`;

    } else if (params.action === "list") {
      const { rows } = await rootDb.sql`
        SELECT id, reminder_text, remind_at
        FROM reminders
        WHERE chat_id = ${chatId} AND delivered = FALSE
        ORDER BY remind_at ASC
      `;

      if (rows.length === 0) {
        return "No pending reminders.";
      }

      const lines = rows.map(r => {
        const remindAt = new Date(/** @type {string} */ (r.remind_at));
        return `#${r.id}: "${r.reminder_text}" at ${formatTime(remindAt)}`;
      });
      return lines.join("\n");

    } else if (params.action === "cancel") {
      if (!params.reminder_id) {
        return "Please specify the reminder ID to cancel (reminder_id).";
      }

      const { rows } = await rootDb.sql`
        DELETE FROM reminders
        WHERE id = ${Number(params.reminder_id)} AND chat_id = ${chatId}
        RETURNING id
      `;

      if (rows.length === 0) {
        return `Reminder not found (ID: ${params.reminder_id}). It may belong to another chat or not exist.`;
      }

      return `Reminder #${rows[0].id} cancelled.`;
    }

    return "Unknown action. Use: set, list, or cancel.";
  },
});
