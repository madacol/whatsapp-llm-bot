import assert from "node:assert/strict";
import { getChatOrThrow } from "../store.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_memory_threshold",
  command: "set memory-threshold",
  description: "Set the minimum similarity threshold (0–1) for long-term memory retrieval. Higher values return only highly relevant memories; lower values return more results.",
  parameters: {
    type: "object",
    properties: {
      value: {
        type: "number",
        description: "Similarity threshold between 0 and 1",
      },
    },
    required: ["value"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function sets_threshold(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-thresh-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-thresh-1", rootDb: db },
        { value: "0.5" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory_threshold FROM chats WHERE chat_id = 'act-thresh-1'`;
      assert.equal(chat.memory_threshold, 0.5);
      assert.ok(result.includes("0.5"));
    },
    async function rejects_out_of_range(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-thresh-2') ON CONFLICT DO NOTHING`;
      await assert.rejects(
        async () => action_fn({ chatId: "act-thresh-2", rootDb: db }, { value: "1.5" }),
      );
      await assert.rejects(
        async () => action_fn({ chatId: "act-thresh-2", rootDb: db }, { value: "-0.1" }),
      );
    },
    async function accepts_numeric_values(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-thresh-3') ON CONFLICT DO NOTHING`;
      await action_fn(
        { chatId: "act-thresh-3", rootDb: db },
        { value: 0.7 },
      );
      const { rows: [chat] } = await db.sql`SELECT memory_threshold FROM chats WHERE chat_id = 'act-thresh-3'`;
      assert.equal(chat.memory_threshold, 0.7);
    },
    async function resets_to_default_with_zero_string(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-thresh-4') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET memory_threshold = 0.8 WHERE chat_id = 'act-thresh-4'`;
      const result = await action_fn(
        { chatId: "act-thresh-4", rootDb: db },
        { value: "0" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory_threshold FROM chats WHERE chat_id = 'act-thresh-4'`;
      assert.equal(chat.memory_threshold, 0);
      assert.ok(typeof result === "string");
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { value }) {
    await getChatOrThrow(rootDb, chatId);

    const threshold = typeof value === "number" ? value : parseFloat(String(value));
    if (isNaN(threshold) || threshold < 0 || threshold > 1) {
      throw new Error("Threshold must be a number between 0 and 1.");
    }

    await rootDb.sql`UPDATE chats SET memory_threshold = ${threshold} WHERE chat_id = ${chatId}`;

    return `Memory similarity threshold set to ${threshold} for this chat.`;
  },
});
