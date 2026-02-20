import assert from "node:assert/strict";
import { setChatEnabled } from "./_setChatEnabled.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "enable_chat",
  command: "enable",
  description: "Enable LLM answers for a specific chat (admin only)",
  parameters: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description:
          "Chat ID to enable (defaults to current chat if not provided)",
      },
    },
    required: [],
  },
  permissions: {
    autoExecute: true,
    requireMaster: true,
    useRootDb: true,
  },
  test_functions: [
    async function enables_existing_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-enable-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-enable-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("enabled"));
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'act-enable-1'`;
      assert.equal(chat.is_enabled, true);
    },
    async function throws_if_chat_does_not_exist(action_fn, db) {
      await assert.rejects(
        () => action_fn({ chatId: "nonexistent-enable", rootDb: db }, {}),
        { message: /does not exist/ },
      );
    },
  ],
  action_fn: async function ({ chatId, rootDb }, params) {
    return setChatEnabled(rootDb, params.chatId || chatId, true);
  },
});
