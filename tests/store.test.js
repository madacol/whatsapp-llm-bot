import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initStore } from "../store.js";

describe("store with injected DB", () => {
  /** @type {PGlite} */
  let db;
  /** @type {Awaited<ReturnType<typeof initStore>>} */
  let store;

  before(async () => {
    db = new PGlite("memory://");
    store = await initStore(db);
  });

  after(async () => {
    await store.closeDb();
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
  });
});
