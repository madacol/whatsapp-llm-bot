import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite as PGliteDriver } from "@electric-sql/pglite";
import { pollReminders } from "../reminder-daemon.js";
import { ensureSchema } from "../actions/tools/reminders/index.js";
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

  it("does not mark reminder as delivered when send fails", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES ('r-fail', 'will fail', ${past})`;

    const sendToChat = async () => { throw new Error("network down"); };
    await pollReminders(db, sendToChat);

    const { rows: [row] } = await db.sql`SELECT delivered FROM reminders WHERE chat_id = 'r-fail'`;
    assert.equal(row.delivered, false);

    // Clean up so this undelivered reminder doesn't leak into later tests
    await db.sql`DELETE FROM reminders WHERE chat_id = 'r-fail'`;
  });

  it("continues delivering remaining reminders after one fails", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES ('r-fail-first', 'first fails', ${past})`;
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES ('r-ok-second', 'second ok', ${past})`;

    /** @type {string[]} */
    const called = [];
    /** @param {string} chatId */
    const sendToChat = async (chatId) => {
      called.push(chatId);
      if (chatId === "r-fail-first") throw new Error("boom");
    };
    await pollReminders(db, sendToChat);

    assert.ok(called.includes("r-fail-first"), "should attempt the failing reminder");
    assert.ok(called.includes("r-ok-second"), "should attempt the succeeding reminder");

    const { rows: [fail] } = await db.sql`SELECT delivered FROM reminders WHERE chat_id = 'r-fail-first'`;
    assert.equal(fail.delivered, false);

    const { rows: [ok] } = await db.sql`SELECT delivered FROM reminders WHERE chat_id = 'r-ok-second'`;
    assert.equal(ok.delivered, true);
  });
});
