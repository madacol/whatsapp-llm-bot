import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {PGlite} */
let db;

/** @type {typeof import("../pending-confirmations.js")} */
let mod;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);
  mod = await import("../pending-confirmations.js");
  await mod.initPendingConfirmationsTable(db);
});

describe("pending-confirmations CRUD", () => {
  it("saves and loads a pending confirmation", async () => {
    await mod.savePendingConfirmation(db, {
      chatId: "chat-1",
      msgKeyId: "msg-key-1",
      msgKeyRemoteJid: "chat-1@g.us",
      actionName: "test_action",
      actionParams: { foo: "bar" },
      toolCallId: "tool-1",
      senderIds: ["sender-a", "sender-b"],
    });

    const rows = await mod.loadPendingConfirmations(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_id, "chat-1");
    assert.equal(rows[0].msg_key_id, "msg-key-1");
    assert.equal(rows[0].msg_key_remote_jid, "chat-1@g.us");
    assert.equal(rows[0].action_name, "test_action");
    assert.deepEqual(rows[0].action_params, { foo: "bar" });
    assert.equal(rows[0].tool_call_id, "tool-1");
    assert.deepEqual(rows[0].sender_ids, ["sender-a", "sender-b"]);
  });

  it("deletes by msgKeyId", async () => {
    await mod.savePendingConfirmation(db, {
      chatId: "chat-2",
      msgKeyId: "msg-key-2",
      msgKeyRemoteJid: "chat-2@g.us",
      actionName: "another_action",
      actionParams: {},
      toolCallId: null,
      senderIds: ["sender-c"],
    });

    // Verify it's there
    let rows = await mod.loadPendingConfirmations(db);
    assert.ok(rows.some(r => r.msg_key_id === "msg-key-2"));

    // Delete
    await mod.deletePendingConfirmation(db, "msg-key-2");

    rows = await mod.loadPendingConfirmations(db);
    assert.ok(!rows.some(r => r.msg_key_id === "msg-key-2"));
  });

  it("loads empty when no pending confirmations exist", async () => {
    // Clean up any leftover rows from previous tests
    await db.query("DELETE FROM pending_confirmations");

    const rows = await mod.loadPendingConfirmations(db);
    assert.equal(rows.length, 0);
  });

  it("rejects duplicate msg_key_id (upserts gracefully)", async () => {
    await mod.savePendingConfirmation(db, {
      chatId: "chat-dup",
      msgKeyId: "dup-key",
      msgKeyRemoteJid: "chat-dup@g.us",
      actionName: "action_v1",
      actionParams: { v: 1 },
      toolCallId: "tc-1",
      senderIds: ["s1"],
    });

    // Save again with same key — should overwrite
    await mod.savePendingConfirmation(db, {
      chatId: "chat-dup",
      msgKeyId: "dup-key",
      msgKeyRemoteJid: "chat-dup@g.us",
      actionName: "action_v2",
      actionParams: { v: 2 },
      toolCallId: "tc-2",
      senderIds: ["s2"],
    });

    const rows = await mod.loadPendingConfirmations(db);
    const row = rows.find(r => r.msg_key_id === "dup-key");
    assert.ok(row);
    assert.equal(row.action_name, "action_v2");
    assert.deepEqual(row.action_params, { v: 2 });
  });
});
