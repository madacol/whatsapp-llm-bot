import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../../../config.js";

const CODEX_CACHE_PATH = path.resolve("data/codex-models.json");

/** @type {ActionDbTestFn[]} */
export default [
  async function applies_basic_setup_choices_in_one_go(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id, is_enabled, respond_on, memory, debug, output_visibility)
      VALUES ('setup-1', false, 'mention', false, true, '{}'::jsonb)
      ON CONFLICT DO NOTHING`;
    await fs.mkdir(path.dirname(CODEX_CACHE_PATH), { recursive: true });
    await fs.writeFile(CODEX_CACHE_PATH, JSON.stringify({
      checkedAt: new Date().toISOString(),
      models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
    }));

    /** @type {Array<{ question: string, options: SelectOption[] }>} */
    const prompts = [];
    /** @type {string[]} */
    const selections = ["mention+reply", "codex", "gpt-5.4"];

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
          selectMany: async (question, options) => {
            prompts.push({ question, options });
            return ["thinking", "changes"];
          },
        },
        {},
      );

      assert.equal(prompts.length, 4, "wizard should skip the enable prompt and ask the remaining setup questions");
      assert.equal(prompts[0]?.question, "When should the bot reply in group chats?");
      assert.ok(result.includes("enabled"), `Expected enabled summary, got: ${result}`);
      assert.ok(result.includes("mention+reply"), `Expected trigger summary, got: ${result}`);
      assert.ok(result.includes("codex"), `Expected harness summary, got: ${result}`);
      assert.ok(result.includes("gpt-5.4"), `Expected harness model summary, got: ${result}`);
      assert.ok(result.includes("thinking on"), `Expected show summary, got: ${result}`);
      assert.ok(result.includes("commands off"), `Expected show summary, got: ${result}`);
      assert.ok(!prompts.some((prompt) => prompt.question === "Enable the bot for this chat?"), "wizard should not ask the enable question");

      const { rows: [chat] } = await db.sql`
        SELECT is_enabled, respond_on, memory, debug, output_visibility, harness, harness_config
        FROM chats
        WHERE chat_id = 'setup-1'
      `;
      assert.equal(chat.is_enabled, true);
      assert.equal(chat.respond_on, "mention+reply");
      assert.equal(chat.memory, false, "setup should no longer modify memory");
      assert.equal(chat.debug, true);
      assert.deepEqual(chat.output_visibility, { commands: false, thinking: true, tools: false });
      assert.equal(chat.harness, "codex");
      assert.equal(chat.harness_config.codex.model, "gpt-5.4");
    } finally {
      config.MASTER_IDs = originalMaster;
      await fs.rm(CODEX_CACHE_PATH, { force: true });
    }
  },

  async function cancels_without_changing_anything(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id, is_enabled, respond_on, memory, debug, output_visibility)
      VALUES ('setup-2', false, 'mention', false, false, '{}'::jsonb)
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
        SELECT is_enabled, respond_on, memory, debug, output_visibility
        FROM chats
        WHERE chat_id = 'setup-2'
      `;
      assert.equal(chat.is_enabled, false);
      assert.equal(chat.respond_on, "mention");
      assert.equal(chat.memory, false);
      assert.equal(chat.debug, false);
      assert.deepEqual(chat.output_visibility, {});
    } finally {
      config.MASTER_IDs = originalMaster;
    }
  },
];
