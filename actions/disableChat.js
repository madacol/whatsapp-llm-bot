import assert from "node:assert/strict";
import { setChatEnabled } from "./_setChatEnabled.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "disable_chat",
  command: "disable",
  description: "Disable LLM answers for a specific chat",
  parameters: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description:
          "Chat ID to disable (defaults to current chat if not provided)",
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
    async function disables_existing_chat(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('act-disable-1', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-disable-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("disabled"));
      const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'act-disable-1'`;
      assert.equal(chat.is_enabled, false);
    },
  ],
  action_fn: async function ({ chatId, rootDb }, params) {
    return setChatEnabled(rootDb, params.chatId || chatId, false);
  },
});
