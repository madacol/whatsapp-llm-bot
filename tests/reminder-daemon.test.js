import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pollReminders } from "../reminder-daemon.js";
import { ensureSchema } from "../actions/reminders.js";
import { createTestDb } from "./helpers.js";

/** @type {PGlite} */
let db;

before(async () => {
  db = await createTestDb();
  await ensureSchema(db);
});

describe("reminder daemon", () => {
  it("delivers a due reminder and calls sendToChat", async () => {
    const chatId = "daemon-chat-1";
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES (${chatId}, 'call mom', ${pastTime})`;

    /** @type {Array<{chatId: string, text: string}>} */
    const sent = [];
    /** @param {string} chatId @param {string} text */
    const mockSendToChat = async (chatId, text) => {
      sent.push({ chatId, text });
    };

    await pollReminders(db, mockSendToChat);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, chatId);
    assert.ok(sent[0].text.includes("call mom"), `Expected 'call mom' in: ${sent[0].text}`);

    // Verify marked as delivered
    const { rows } = await db.sql`SELECT delivered FROM reminders WHERE chat_id = ${chatId} AND reminder_text = 'call mom'`;
    assert.equal(rows[0].delivered, true);
  });

  it("does NOT deliver a future reminder", async () => {
    const chatId = "daemon-chat-2";
    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES (${chatId}, 'future task', ${futureTime})`;

    /** @type {Array<{chatId: string, text: string}>} */
    const sent = [];
    /** @param {string} chatId @param {string} text */
    const mockSendToChat = async (chatId, text) => {
      sent.push({ chatId, text });
    };

    await pollReminders(db, mockSendToChat);

    assert.equal(sent.length, 0);

    // Verify still not delivered
    const { rows } = await db.sql`SELECT delivered FROM reminders WHERE chat_id = ${chatId} AND reminder_text = 'future task'`;
    assert.equal(rows[0].delivered, false);
  });

  it("does NOT re-send already delivered reminders", async () => {
    const chatId = "daemon-chat-3";
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    await db.sql`INSERT INTO reminders (chat_id, reminder_text, remind_at, delivered) VALUES (${chatId}, 'already done', ${pastTime}, TRUE)`;

    /** @type {Array<{chatId: string, text: string}>} */
    const sent = [];
    /** @param {string} chatId @param {string} text */
    const mockSendToChat = async (chatId, text) => {
      sent.push({ chatId, text });
    };

    await pollReminders(db, mockSendToChat);

    assert.equal(sent.length, 0);
  });
});
