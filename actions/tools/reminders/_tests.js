import assert from "node:assert/strict";
import { ensureSchema } from "./index.js";

export default [
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
];
