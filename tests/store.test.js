import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initStore, assertChatExists } from "../store.js";
import { createTestDb } from "./helpers.js";

describe("store with injected DB", () => {
  /** @type {import("@electric-sql/pglite").PGlite} */
  let db;
  /** @type {Awaited<ReturnType<typeof initStore>>} */
  let store;

  before(async () => {
    db = await createTestDb();
    store = await initStore(db);
  });

  it("does not create module-owned tables (reminders, content_translations)", async () => {
    // Use a fresh DB to avoid pollution from other test files sharing createTestDb()
    const freshDb = new PGlite("memory://");
    await initStore(freshDb);
    const { rows } = await freshDb.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    const tableNames = rows.map(r => r.table_name);
    assert.ok(!tableNames.includes("reminders"), `initStore() should not create 'reminders' table, got: ${tableNames}`);
    assert.ok(!tableNames.includes("content_translations"), `initStore() should not create 'content_translations' table, got: ${tableNames}`);
  });

  describe("createChat / getChat", () => {
    it("creates a chat and retrieves it", async () => {
      await store.createChat("store-test-1");
      const chat = await store.getChat("store-test-1");

      assert.ok(chat);
      assert.equal(chat.chat_id, "store-test-1");
      assert.equal(chat.is_enabled, false);
      assert.equal(chat.system_prompt, null);
      assert.equal(chat.model, null);
    });

    it("does not error on duplicate createChat", async () => {
      await store.createChat("store-test-1");
      const chat = await store.getChat("store-test-1");
      assert.ok(chat);
    });

    it("returns undefined for nonexistent chat", async () => {
      const chat = await store.getChat("nonexistent");
      assert.equal(chat, undefined);
    });
  });

  describe("assertChatExists", () => {
    it("resolves for an existing chat", async () => {
      await store.createChat("assert-exists-1");
      await assertChatExists(db, "assert-exists-1");
    });

    it("throws for a nonexistent chat", async () => {
      await assert.rejects(
        () => assertChatExists(db, "no-such-chat"),
        { message: "Chat no-such-chat does not exist." }
      );
    });
  });

  describe("addMessage / getMessages", () => {
    it("adds and retrieves a user message", async () => {
      await store.createChat("msg-test-1");

      /** @type {UserMessage} */
      const msg = { role: "user", content: [{ type: "text", text: "hello" }] };
      const result = await store.addMessage("msg-test-1", msg, ["sender-1"]);

      assert.ok(result.message_id);
      assert.equal(result.chat_id, "msg-test-1");

      const messages = await store.getMessages("msg-test-1");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message_data.role, "user");
    });

    it("returns messages in descending timestamp order", async () => {
      await store.createChat("msg-test-2");

      /** @type {UserMessage} */
      const msg1 = { role: "user", content: [{ type: "text", text: "first" }] };
      /** @type {UserMessage} */
      const msg2 = { role: "user", content: [{ type: "text", text: "second" }] };
      await store.addMessage("msg-test-2", msg1, ["s1"]);
      await store.addMessage("msg-test-2", msg2, ["s1"]);

      const messages = await store.getMessages("msg-test-2");
      assert.equal(messages.length, 2);
      // Newest first (DESC order)
      assert.equal(messages[0].message_data.content[0].text, "second");
      assert.equal(messages[1].message_data.content[0].text, "first");
    });

    it("respects the limit parameter", async () => {
      await store.createChat("msg-test-3");

      for (let i = 0; i < 5; i++) {
        /** @type {UserMessage} */
        const msg = { role: "user", content: [{ type: "text", text: `msg ${i}` }] };
        await store.addMessage("msg-test-3", msg, ["s1"]);
      }

      const messages = await store.getMessages("msg-test-3", 2);
      assert.equal(messages.length, 2);
    });

    it("stores assistant messages", async () => {
      await store.createChat("msg-test-4");

      /** @type {AssistantMessage} */
      const msg = {
        role: "assistant",
        content: [
          { type: "text", text: "Hello!" },
          { type: "tool", tool_id: "c1", name: "test", arguments: "{}" },
        ],
      };
      await store.addMessage("msg-test-4", msg, ["bot"]);

      const messages = await store.getMessages("msg-test-4");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message_data.role, "assistant");
      assert.equal(messages[0].message_data.content.length, 2);
    });

    it("stores tool messages", async () => {
      await store.createChat("msg-test-5");

      /** @type {ToolMessage} */
      const msg = {
        role: "tool",
        tool_id: "call_123",
        content: [{ type: "text", text: "result data" }],
      };
      await store.addMessage("msg-test-5", msg, ["bot"]);

      const messages = await store.getMessages("msg-test-5");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message_data.role, "tool");
    });

    it("excludes cleared messages by default", async () => {
      await store.createChat("msg-test-cleared");

      /** @type {UserMessage} */
      const msg1 = { role: "user", content: [{ type: "text", text: "before clear" }] };
      /** @type {UserMessage} */
      const msg2 = { role: "user", content: [{ type: "text", text: "after clear" }] };
      await store.addMessage("msg-test-cleared", msg1, ["s1"]);
      // Mark existing messages as cleared
      await db.sql`UPDATE messages SET cleared_at = NOW() WHERE chat_id = 'msg-test-cleared'`;
      await store.addMessage("msg-test-cleared", msg2, ["s1"]);

      const messages = await store.getMessages("msg-test-cleared");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message_data.content[0].text, "after clear");
    });
  });
});
