import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "set_response_mode",
  command: "set response",
  description: "Configure when the bot responds in a group chat. Set respond_on_any, respond_on_mention, and/or respond_on_reply independently.",
  parameters: {
    type: "object",
    properties: {
      respond_on_any: {
        type: "boolean",
        description: "Respond to any message",
      },
      respond_on_mention: {
        type: "boolean",
        description: "Respond when mentioned",
      },
      respond_on_reply: {
        type: "boolean",
        description: "Respond when replying to bot's message",
      },
    },
    required: [],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  test_functions: [
    async function sets_respond_on_reply(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-srm-1') ON CONFLICT DO NOTHING`;
      await action_fn(
        { chatId: "act-srm-1", rootDb: db },
        { respond_on_reply: "true" },
      );
      const { rows: [chat] } = await db.sql`SELECT respond_on_reply FROM chats WHERE chat_id = 'act-srm-1'`;
      assert.equal(chat.respond_on_reply, true);
    },
    async function sets_both_options(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-srm-2') ON CONFLICT DO NOTHING`;
      await action_fn(
        { chatId: "act-srm-2", rootDb: db },
        { respond_on_mention: "false", respond_on_reply: "true" },
      );
      const { rows: [chat] } = await db.sql`SELECT respond_on_mention, respond_on_reply FROM chats WHERE chat_id = 'act-srm-2'`;
      assert.equal(chat.respond_on_mention, false);
      assert.equal(chat.respond_on_reply, true);
    },
    async function sets_respond_on_any(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-srm-3') ON CONFLICT DO NOTHING`;
      await action_fn(
        { chatId: "act-srm-3", rootDb: db },
        { respond_on_any: "true" },
      );
      const { rows: [chat] } = await db.sql`SELECT respond_on_any FROM chats WHERE chat_id = 'act-srm-3'`;
      assert.equal(chat.respond_on_any, true);
    },
    async function accepts_boolean_values(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-srm-4') ON CONFLICT DO NOTHING`;
      await action_fn(
        { chatId: "act-srm-4", rootDb: db },
        { respond_on_any: true, respond_on_mention: false },
      );
      const { rows: [chat] } = await db.sql`SELECT respond_on_any, respond_on_mention FROM chats WHERE chat_id = 'act-srm-4'`;
      assert.equal(chat.respond_on_any, true);
      assert.equal(chat.respond_on_mention, false);
    },
  ],
  action_fn: async function ({ chatId, rootDb }, params) {
    const {
      rows: [chatExists],
    } =
      await rootDb.sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

    if (!chatExists) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    /**
     * Parse a string-or-boolean param to a boolean.
     * @param {unknown} raw
     * @returns {boolean}
     */
    const toBool = (raw) => String(raw).toLowerCase() === "true";

    /** @type {Promise<unknown>[]} */
    const updates = [];
    /** @type {string[]} */
    const messages = [];

    if (params.respond_on_any !== undefined) {
      const value = toBool(params.respond_on_any);
      updates.push(rootDb.sql`UPDATE chats SET respond_on_any = ${value} WHERE chat_id = ${chatId}`);
      messages.push(`respond_on_any: ${value}`);
    }
    if (params.respond_on_mention !== undefined) {
      const value = toBool(params.respond_on_mention);
      updates.push(rootDb.sql`UPDATE chats SET respond_on_mention = ${value} WHERE chat_id = ${chatId}`);
      messages.push(`respond_on_mention: ${value}`);
    }
    if (params.respond_on_reply !== undefined) {
      const value = toBool(params.respond_on_reply);
      updates.push(rootDb.sql`UPDATE chats SET respond_on_reply = ${value} WHERE chat_id = ${chatId}`);
      messages.push(`respond_on_reply: ${value}`);
    }

    if (updates.length === 0) {
      return "No changes requested. Use `respond_on_any`, `respond_on_mention`, and/or `respond_on_reply` parameters.";
    }

    await Promise.all(updates);

    return `✅ Response mode updated for chat ${chatId}\n\n*Settings:*\n${messages.join("\n")}`;
  },
});
