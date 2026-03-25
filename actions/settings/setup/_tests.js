import assert from "node:assert/strict";
import config from "../../../config.js";

/** @type {ActionDbTestFn[]} */
export default [
  async function applies_basic_setup_choices_in_one_go(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id, is_enabled, respond_on, memory, debug)
      VALUES ('setup-1', false, 'mention', false, true)
      ON CONFLICT DO NOTHING`;

    /** @type {Array<{ question: string, options: SelectOption[] }>} */
    const prompts = [];
    /** @type {string[]} */
    const selections = ["on", "mention+reply", "on", "off"];

    const originalMaster = config.MASTER_IDs;
    config.MASTER_IDs = ["master-user"];
    try {
      const result = await action_fn(
        {
          chatId: "setup-1",
          rootDb: db,
          senderIds: ["master-user"],
          getIsAdmin: async () => true,
          select: async (question, options) => {
            prompts.push({ question, options });
            return selections.shift() ?? "";
          },
        },
        {},
      );

      assert.equal(prompts.length, 4, "wizard should ask all basic setup questions");
      assert.ok(result.includes("enabled"), `Expected enabled summary, got: ${result}`);
      assert.ok(result.includes("mention+reply"), `Expected trigger summary, got: ${result}`);
      assert.ok(result.toLowerCase().includes("memory"), `Expected memory summary, got: ${result}`);
      assert.ok(result.toLowerCase().includes("debug"), `Expected debug summary, got: ${result}`);

      const { rows: [chat] } = await db.sql`
        SELECT is_enabled, respond_on, memory, debug
        FROM chats
        WHERE chat_id = 'setup-1'
      `;
      assert.equal(chat.is_enabled, true);
      assert.equal(chat.respond_on, "mention+reply");
      assert.equal(chat.memory, true);
      assert.equal(chat.debug, false);
    } finally {
      config.MASTER_IDs = originalMaster;
    }
  },

  async function cancels_without_changing_anything(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id, is_enabled, respond_on, memory, debug)
      VALUES ('setup-2', false, 'mention', false, false)
      ON CONFLICT DO NOTHING`;

    const originalMaster = config.MASTER_IDs;
    config.MASTER_IDs = ["master-user"];
    try {
      const result = await action_fn(
        {
          chatId: "setup-2",
          rootDb: db,
          senderIds: ["master-user"],
          getIsAdmin: async () => true,
          select: async () => "",
        },
        {},
      );

      assert.ok(result.toLowerCase().includes("cancel"), `Expected cancellation message, got: ${result}`);

      const { rows: [chat] } = await db.sql`
        SELECT is_enabled, respond_on, memory, debug
        FROM chats
        WHERE chat_id = 'setup-2'
      `;
      assert.equal(chat.is_enabled, false);
      assert.equal(chat.respond_on, "mention");
      assert.equal(chat.memory, false);
      assert.equal(chat.debug, false);
    } finally {
      config.MASTER_IDs = originalMaster;
    }
  },
];
