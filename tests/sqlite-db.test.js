import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SqliteDb } from "../sqlite-db.js";
import { initStore } from "../store.js";
import { ensureChatStoreSchema } from "../store/schema/chat.js";

describe("SqliteDb chat storage", () => {
  it("stores and reads JSON chat messages through the shared db facade", async () => {
    const db = new SqliteDb(":memory:");
    try {
      await ensureChatStoreSchema(db);
      await db.sql`
        INSERT INTO messages (chat_id, sender_id, message_data, display_key)
        VALUES (${"sqlite-chat"}, ${"sender"}, ${{ role: "user", content: [{ type: "text", text: "hello sqlite" }] }}, ${"m1"})
      `;

      const { rows } = await db.sql`
        SELECT message_data
        FROM messages
        WHERE json_extract(message_data, '$.content[0].text') = ${"hello sqlite"}
      `;

      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].message_data, {
        role: "user",
        content: [{ type: "text", text: "hello sqlite" }],
      });
    } finally {
      await db.close();
    }
  });

  it("returns same-day messages inserted with SQLite default timestamps", async () => {
    const rootDb = new SqliteDb(":memory:");
    const chatDb = new SqliteDb(":memory:");
    try {
      const store = await initStore(rootDb, { getChatDb: () => chatDb });
      await store.createChat("sqlite-chat");
      await store.addMessage("sqlite-chat", {
        role: "user",
        content: [{ type: "text", text: "visible same-day message" }],
      });

      const messages = await store.getMessages("sqlite-chat", new Date(Date.now() - 8 * 60 * 60 * 1000));

      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0].message_data, {
        role: "user",
        content: [{ type: "text", text: "visible same-day message" }],
      });
    } finally {
      await chatDb.close();
      await rootDb.close();
    }
  });
});
