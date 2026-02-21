import assert from "node:assert/strict";

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

/**
 * Format a timestamp for display.
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  return date.toLocaleString("en-EN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
  permissions: {
    autoExecute: true,
    useRootDb: true,
  },
  test_functions: [
    async function set_reminder_stores_in_db(action_fn, db) {
      await ensureSchema(db);
      const futureDate = new Date(Date.now() + 3600_000).toISOString();
      const result = await action_fn(
        { rootDb: db, chatId: "test-chat", log: async () => "" },
        { action: "set", reminder_text: "call mom", remind_at: futureDate },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("call mom"), `Expected 'call mom' in: ${result}`);

      const { rows } = await db.sql`SELECT * FROM reminders WHERE chat_id = 'test-chat' AND reminder_text = 'call mom'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].delivered, false);
    },

    async function set_reminder_rejects_past(action_fn, db) {
      await ensureSchema(db);
      const pastDate = new Date(Date.now() - 3600_000).toISOString();
      const result = await action_fn(
        { rootDb: db, chatId: "test-chat", log: async () => "" },
        { action: "set", reminder_text: "too late", remind_at: pastDate },
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("past") || result.toLowerCase().includes("future"),
        `Expected rejection message, got: ${result}`,
      );
    },

    async function list_reminders_empty(action_fn, db) {
      await ensureSchema(db);
      // Use a unique chat to avoid leaks from other tests
      const result = await action_fn(
        { rootDb: db, chatId: "empty-chat-list", log: async () => "" },
        { action: "list" },
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("no") || result.toLowerCase().includes("empty"),
        `Expected empty message, got: ${result}`,
      );
    },

    async function list_reminders_shows_pending(action_fn, db) {
      await ensureSchema(db);
      const chatId = "list-chat";
      const future1 = new Date(Date.now() + 3600_000).toISOString();
      const future2 = new Date(Date.now() + 7200_000).toISOString();
      await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES (${chatId}, 'reminder A', ${future1})`;
      await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES (${chatId}, 'reminder B', ${future2})`;
      // Also insert a delivered one that should NOT show
      await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at, delivered) VALUES (${chatId}, 'done one', ${future1}, TRUE)`;

      const result = await action_fn(
        { rootDb: db, chatId, log: async () => "" },
        { action: "list" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("reminder A"), `Should include 'reminder A', got: ${result}`);
      assert.ok(result.includes("reminder B"), `Should include 'reminder B', got: ${result}`);
      assert.ok(!result.includes("done one"), `Should NOT include delivered reminder, got: ${result}`);
    },

    async function cancel_reminder(action_fn, db) {
      await ensureSchema(db);
      const chatId = "cancel-chat";
      const future = new Date(Date.now() + 3600_000).toISOString();
      await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES (${chatId}, 'to cancel', ${future})`;
      const { rows: [row] } = await db.sql`SELECT id FROM reminders WHERE reminder_text = 'to cancel'`;

      const result = await action_fn(
        { rootDb: db, chatId, log: async () => "" },
        { action: "cancel", reminder_id: String(row.id) },
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("cancel") || result.toLowerCase().includes("deleted"),
        `Expected cancellation confirmation, got: ${result}`,
      );

      const { rows } = await db.sql`SELECT * FROM reminders WHERE id = ${row.id}`;
      assert.equal(rows.length, 0);
    },

    async function cancel_wrong_chat(action_fn, db) {
      await ensureSchema(db);
      const future = new Date(Date.now() + 3600_000).toISOString();
      await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES ('other-chat', 'not yours', ${future})`;
      const { rows: [row] } = await db.sql`SELECT id FROM reminders WHERE reminder_text = 'not yours'`;

      const result = await action_fn(
        { rootDb: db, chatId: "my-chat", log: async () => "" },
        { action: "cancel", reminder_id: String(row.id) },
      );
      assert.ok(typeof result === "string");
      assert.ok(
        result.toLowerCase().includes("not found") || result.toLowerCase().includes("no"),
        `Expected not-found message, got: ${result}`,
      );

      // Verify it was NOT deleted
      const { rows } = await db.sql`SELECT * FROM reminders WHERE id = ${row.id}`;
      assert.equal(rows.length, 1);
    },
  ],
  /**
   * @param {ExtendedActionContext<{autoExecute: true, useRootDb: true}>} context
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
