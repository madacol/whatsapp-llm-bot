import assert from "node:assert/strict";

/** @type {ActionDbTestFn[]} */
export default [
async function returns_empty_when_no_messages_in_range(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-1') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-recall-1'`;
      const result = await action_fn(
        { chatId: "act-recall-1", rootDb: db },
        { since: "2026-01-01T00:00:00Z" },
      );
      assert.ok(result.includes("No messages found"));
    },

    async function returns_messages_since_timestamp(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-2') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-recall-2'`;
      // Insert messages at specific timestamps
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-2', 'u1', '{"role":"user","content":[{"type":"text","text":"old message"}]}', '2026-02-10 08:00:00')`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-2', 'u1', '{"role":"user","content":[{"type":"text","text":"recent message"}]}', '2026-02-19 10:00:00')`;
      const result = await action_fn(
        { chatId: "act-recall-2", rootDb: db },
        { since: "2026-02-10T00:00:00Z" },
      );
      assert.ok(result.includes("old message"), "should include old message");
      assert.ok(result.includes("recent message"), "should include recent message");
    },

    async function excludes_messages_before_since(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-3') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-recall-3'`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-3', 'u1', '{"role":"user","content":[{"type":"text","text":"too old"}]}', '2026-01-01 08:00:00')`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-3', 'u1', '{"role":"user","content":[{"type":"text","text":"in range"}]}', '2026-02-15 10:00:00')`;
      const result = await action_fn(
        { chatId: "act-recall-3", rootDb: db },
        { since: "2026-02-01T00:00:00Z" },
      );
      assert.ok(!result.includes("too old"), "should exclude message before since");
      assert.ok(result.includes("in range"), "should include message after since");
    },

    async function respects_limit(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-4') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-recall-4'`;
      for (let i = 0; i < 5; i++) {
        await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
          VALUES ('act-recall-4', 'u1', ${JSON.stringify({ role: "user", content: [{ type: "text", text: `recall-msg${i}` }] })}, ${`2026-02-19 0${i}:00:00`})`;
      }
      const result = await action_fn(
        { chatId: "act-recall-4", rootDb: db },
        { since: "2026-02-19T00:00:00Z", limit: 3 },
      );
      // Oldest 3: msg0, msg1, msg2
      assert.ok(result.includes("recall-msg0"));
      assert.ok(result.includes("recall-msg2"));
      assert.ok(!result.includes("recall-msg4"), "should not include beyond limit");
    },

    async function returns_only_messages_between_since_and_until(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-until-1') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-recall-until-1'`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-until-1', 'u1', '{"role":"user","content":[{"type":"text","text":"before window"}]}', '2026-02-10 06:00:00')`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-until-1', 'u1', '{"role":"user","content":[{"type":"text","text":"in window"}]}', '2026-02-10 12:00:00')`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-until-1', 'u1', '{"role":"user","content":[{"type":"text","text":"after window"}]}', '2026-02-10 20:00:00')`;
      const result = await action_fn(
        { chatId: "act-recall-until-1", rootDb: db },
        { since: "2026-02-10T08:00:00Z", until: "2026-02-10T15:00:00Z" },
      );
      assert.ok(!result.includes("before window"), "should exclude message before since");
      assert.ok(result.includes("in window"), "should include message in window");
      assert.ok(!result.includes("after window"), "should exclude message after until");
    },

    async function without_until_returns_all_from_since(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-until-2') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-recall-until-2'`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-until-2', 'u1', '{"role":"user","content":[{"type":"text","text":"msg early"}]}', '2026-02-10 08:00:00')`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-until-2', 'u1', '{"role":"user","content":[{"type":"text","text":"msg late"}]}', '2026-02-19 20:00:00')`;
      const result = await action_fn(
        { chatId: "act-recall-until-2", rootDb: db },
        { since: "2026-02-10T00:00:00Z" },
      );
      assert.ok(result.includes("msg early"), "should include early message");
      assert.ok(result.includes("msg late"), "should include late message (no until bound)");
    },

    async function rejects_invalid_since_timestamp(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-6') ON CONFLICT DO NOTHING`;
      const result = await action_fn({ chatId: "act-recall-6", rootDb: db }, { since: "yesterday" });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("Invalid"), `Expected "Invalid" in result, got: ${result}`);
    },

    async function formats_messages_with_role_and_text(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-recall-5') ON CONFLICT DO NOTHING`;
      await db.sql`DELETE FROM messages WHERE chat_id = 'act-recall-5'`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-5', 'u1', '{"role":"user","content":[{"type":"text","text":"hello from past"}]}', '2026-02-19 08:00:00')`;
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('act-recall-5', null, '{"role":"assistant","content":[{"type":"text","text":"bot reply"}]}', '2026-02-19 08:01:00')`;
      const result = await action_fn(
        { chatId: "act-recall-5", rootDb: db },
        { since: "2026-02-19T00:00:00Z" },
      );
      assert.ok(result.includes("[user]"), "should have user role label");
      assert.ok(result.includes("hello from past"));
      assert.ok(result.includes("[assistant]"), "should have assistant role label");
      assert.ok(result.includes("bot reply"));
    },
];
