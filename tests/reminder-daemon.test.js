import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pollReminders } from "../reminder-daemon.js";
import { ensureSchema } from "../actions/tools/reminders.js";
import { createTestDb } from "./helpers.js";

/** @type {PGlite} */
let db;

before(async () => {
  db = await createTestDb();
  await ensureSchema(db);
});

describe("reminder daemon", () => {
  it("delivers only due, undelivered reminders", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();

    // Seed three reminders: due, future, already delivered
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES ('r-due', 'call mom', ${past})`;
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES ('r-future', 'future task', ${future})`;
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at, delivered) VALUES ('r-done', 'already done', ${past}, TRUE)`;

    /** @type {Array<{chatId: string, text: string}>} */
    const sent = [];
    await pollReminders(db, async (chatId, text) => sent.push({ chatId, text }));

    // Only the due reminder should fire
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "r-due");
    assert.ok(sent[0].text.includes("call mom"));

    // Due reminder marked delivered
    const { rows: dueRows } = await db.sql`SELECT delivered FROM reminders WHERE chat_id = 'r-due'`;
    assert.equal(dueRows[0].delivered, true);

    // Future reminder still pending
    const { rows: futureRows } = await db.sql`SELECT delivered FROM reminders WHERE chat_id = 'r-future'`;
    assert.equal(futureRows[0].delivered, false);
  });
});
