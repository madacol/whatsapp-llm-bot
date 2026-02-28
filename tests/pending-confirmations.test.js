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
