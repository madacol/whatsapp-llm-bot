import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "get_system_prompt",
  command: "get prompt",
  description: "Get the current system prompt for a chat (admin only)",
  parameters: {
    type: "object",
    properties: {},
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function returns_custom_prompt_when_set(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, system_prompt) VALUES ('act-gprompt-1', 'custom prompt') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-gprompt-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("custom prompt"));
    },
    async function indicates_default_when_no_custom_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-gprompt-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-gprompt-2", rootDb: db },
        {},
      );
      assert.ok(result.includes("default"));
    },
  ],
  action_fn: async function ({ chatId, rootDb }) {
    const {
      rows: [chatInfo],
    } =
      await rootDb.sql`SELECT chat_id, system_prompt FROM chats WHERE chat_id = ${chatId}`;

    if (!chatInfo) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    if (chatInfo.system_prompt) {
      return `*Custom system prompt for chat ${chatId}:*\n\n${chatInfo.system_prompt}`;
    } else {
      return `*Chat ${chatId} is using the default system prompt:*\n\n${(await import("../config.js")).default.system_prompt}`;
    }
  },
});
