import assert from "node:assert/strict";
import { getChatOrThrow } from "../../store.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_chat_enabled",
  command: "set enabled",
  description: "Enable or disable LLM answers for a chat (master only). Pass true to enable, false to disable.",
  parameters: {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        description: "true to enable, false to disable",
      },
      chatId: {
        type: "string",
        description: "Chat ID to target (defaults to current chat if not provided)",
      },
    },
    required: ["enabled"],
  },
  permissions: {
    autoExecute: true,
    requireMaster: true,
    useRootDb: true,
  },
  test_functions: [
    async function enables_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('sce-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "sce-1", rootDb: db },
        { enabled: "true" },
      );
      assert.ok(result.includes("enabled"));
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'sce-1'`;
      assert.equal(chat.is_enabled, true);
    },
    async function disables_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('sce-2', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "sce-2", rootDb: db },
        { enabled: "false" },
      );
      assert.ok(result.includes("disabled"));
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'sce-2'`;
      assert.equal(chat.is_enabled, false);
    },
    async function targets_different_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('sce-3') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "other-chat", rootDb: db },
        { enabled: "true", chatId: "sce-3" },
      );
      assert.ok(result.includes("enabled"));
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'sce-3'`;
      assert.equal(chat.is_enabled, true);
    },
    async function throws_if_chat_does_not_exist(action_fn, db) {
      await assert.rejects(
        () => action_fn({ chatId: "nonexistent-sce", rootDb: db }, { enabled: "true" }),
        { message: /does not exist/ },
      );
    },
    async function accepts_boolean_values(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('sce-5') ON CONFLICT DO NOTHING`;
      await action_fn(
        { chatId: "sce-5", rootDb: db },
        { enabled: true },
      );
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'sce-5'`;
      assert.equal(chat.is_enabled, true);
    },
  ],
  action_fn: async function ({ chatId, rootDb }, { enabled, chatId: targetChatId }) {
    const target = targetChatId || chatId;
    await getChatOrThrow(rootDb, target);

    const value = typeof enabled === "boolean" ? enabled : String(enabled).toLowerCase() === "true";

    await rootDb.sql`
      UPDATE chats
      SET is_enabled = ${value}
      WHERE chat_id = ${target}
    `;

    return `Bot ${value ? "enabled" : "disabled"}.`;
  },
});
