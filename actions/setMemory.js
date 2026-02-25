import assert from "node:assert/strict";
import { getChatOrThrow } from "../store.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_memory",
  command: "set memory",
  description: "Enable or disable long-term memory (semantic similarity search) for this chat. When enabled, the bot automatically recalls relevant past conversations.",
  parameters: {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        description: "true to enable, false to disable",
      },
    },
    required: ["enabled"],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function enables_memory(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-mem-1", rootDb: db },
        { enabled: "true" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'act-mem-1'`;
      assert.equal(chat.memory, true);
      assert.ok(result.toLowerCase().includes("enabled"));
    },
    async function disables_memory(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-2') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET memory = true WHERE chat_id = 'act-mem-2'`;
      const result = await action_fn(
        { chatId: "act-mem-2", rootDb: db },
        { enabled: "false" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'act-mem-2'`;
      assert.equal(chat.memory, false);
      assert.ok(result.toLowerCase().includes("disabled"));
    },
    async function accepts_boolean_values(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-mem-3') ON CONFLICT DO NOTHING`;
      await action_fn(
        { chatId: "act-mem-3", rootDb: db },
        { enabled: true },
      );
      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'act-mem-3'`;
      assert.equal(chat.memory, true);
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { enabled }) {
    await getChatOrThrow(rootDb, chatId);

    const value = typeof enabled === "boolean" ? enabled : String(enabled).toLowerCase() === "true";
    await rootDb.sql`UPDATE chats SET memory = ${value} WHERE chat_id = ${chatId}`;

    return `Long-term memory ${value ? "enabled" : "disabled"} for this chat.`;
  },
});
