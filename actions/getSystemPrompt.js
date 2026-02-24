import assert from "node:assert/strict";
import config from "../config.js";
import { getChatOrThrow } from "../store.js";

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
    const chatInfo = await getChatOrThrow(rootDb, chatId);

    if (chatInfo.system_prompt) {
      return `Prompt: ${chatInfo.system_prompt}`;
    } else {
      return `Prompt (default): ${config.system_prompt}`;
    }
  },
});
