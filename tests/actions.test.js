import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers.js";

describe("action unit tests", () => {
  /** @type {PGlite} */
  let db;

  before(async () => {
    db = await createTestDb();
  });

  after(async () => {
    await db.close();
  });

  describe("enableChat", () => {
    it("enables an existing chat", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-enable-1') ON CONFLICT DO NOTHING`;
      const mod = await import("../actions/enableChat.js");
      const result = await mod.default.action_fn(
        { chatId: "act-enable-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("enabled"));

      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'act-enable-1'`;
      assert.equal(chat.is_enabled, true);
    });

    it("throws if chat does not exist", async () => {
      const mod = await import("../actions/enableChat.js");
      await assert.rejects(
        () => mod.default.action_fn({ chatId: "nonexistent", rootDb: db }, {}),
        { message: /does not exist/ },
      );
    });
  });

  describe("disableChat", () => {
    it("disables an existing chat", async () => {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('act-disable-1', true) ON CONFLICT DO NOTHING`;
      const mod = await import("../actions/disableChat.js");
      const result = await mod.default.action_fn(
        { chatId: "act-disable-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("disabled"));

      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'act-disable-1'`;
      assert.equal(chat.is_enabled, false);
    });
  });

  describe("setSystemPrompt", () => {
    it("sets system prompt for a chat", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-prompt-1') ON CONFLICT DO NOTHING`;
      const mod = await import("../actions/setSystemPrompt.js");
      const result = await mod.default.action_fn(
        { chatId: "act-prompt-1", rootDb: db },
        { prompt: "Be a pirate" },
      );
      assert.ok(result.includes("pirate"));

      const { rows: [chat] } = await db.sql`SELECT system_prompt FROM chats WHERE chat_id = 'act-prompt-1'`;
      assert.equal(chat.system_prompt, "Be a pirate");
    });

    it("throws on empty prompt", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-prompt-2') ON CONFLICT DO NOTHING`;
      const mod = await import("../actions/setSystemPrompt.js");
      await assert.rejects(
        () => mod.default.action_fn({ chatId: "act-prompt-2", rootDb: db }, { prompt: "  " }),
        { message: /empty/ },
      );
    });
  });

  describe("getSystemPrompt", () => {
    it("returns custom prompt when set", async () => {
      await db.sql`INSERT INTO chats(chat_id, system_prompt) VALUES ('act-gprompt-1', 'custom prompt') ON CONFLICT DO NOTHING`;
      const mod = await import("../actions/getSystemPrompt.js");
      const result = await mod.default.action_fn(
        { chatId: "act-gprompt-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("custom prompt"));
    });

    it("indicates default when no custom prompt", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-gprompt-2') ON CONFLICT DO NOTHING`;
      const mod = await import("../actions/getSystemPrompt.js");
      const result = await mod.default.action_fn(
        { chatId: "act-gprompt-2", rootDb: db },
        {},
      );
      assert.ok(result.includes("default"));
    });
  });

  describe("newConversation", () => {
    it("clears messages for a chat", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-new-1') ON CONFLICT DO NOTHING`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data) VALUES ('act-new-1', 's1', '{"role":"user","content":[{"type":"text","text":"hi"}]}')`;

      const { rows: before } = await db.sql`SELECT * FROM messages WHERE chat_id = 'act-new-1'`;
      assert.equal(before.length, 1);

      const mod = await import("../actions/newConversation.js");
      const result = await mod.default.action_fn(
        { chatId: "act-new-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("clear"));

      const { rows: afterClear } = await db.sql`SELECT * FROM messages WHERE chat_id = 'act-new-1'`;
      assert.equal(afterClear.length, 0);
    });
  });

  describe("showInfo", () => {
    it("returns chat info with ID, status, and sender", async () => {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('act-info-1', true) ON CONFLICT DO NOTHING`;
      const mod = await import("../actions/showInfo.js");
      const result = await mod.default.action_fn(
        {
          chatId: "act-info-1",
          rootDb: db,
          senderIds: ["user-1"],
          content: [{ type: "text", text: "!info" }],
        },
        {},
      );
      assert.ok(result.includes("act-info-1"));
      assert.ok(result.includes("enabled"));
      assert.ok(result.includes("user-1"));
    });
  });

  describe("runJavascript", () => {
    it("executes a function and returns the result", async () => {
      const mod = await import("../actions/runJavascript.js");
      const result = await mod.default.action_fn(
        { chatId: "rjs-1" },
        { code: "({chatId}) => chatId" },
      );
      assert.equal(result, "rjs-1");
    });

    it("throws on non-function code", async () => {
      const mod = await import("../actions/runJavascript.js");
      await assert.rejects(
        () => mod.default.action_fn({}, { code: "42" }),
        { message: /function/ },
      );
    });

    it("throws on syntax error", async () => {
      const mod = await import("../actions/runJavascript.js");
      await assert.rejects(
        () => mod.default.action_fn({}, { code: "{{invalid" }),
      );
    });
  });
});
