import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../../../config.js";
import { readChatConfig, writeChatConfig } from "../../../chat-config.js";
import { getScopedHarnessConfig } from "../../../harness-config.js";

const CODEX_CACHE_PATH = path.resolve("data/codex-models.json");

/**
 * @param {string} chatId
 * @returns {Promise<import("../../../store.js").ChatRow>}
 */
async function readRequiredConfig(chatId) {
  const chat = await readChatConfig(chatId);
  assert.ok(chat, `expected config for ${chatId}`);
  return chat;
}

/** @type {ActionDbTestFn[]} */
export default [
  async function applies_basic_setup_choices_in_one_go(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id) VALUES ('setup-1') ON CONFLICT DO NOTHING`;
    await writeChatConfig("setup-1", {
      chat_id: "setup-1",
      is_enabled: false,
      respond_on: "mention",
      memory: false,
      debug: true,
      output_visibility: {},
    });
    await fs.mkdir(path.dirname(CODEX_CACHE_PATH), { recursive: true });
    await fs.writeFile(CODEX_CACHE_PATH, JSON.stringify({
      checkedAt: new Date().toISOString(),
      models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
    }));

    /** @type {string[]} */
    const selections = ["mention+reply", "codex", "gpt-5.4", "danger-full-access"];

    const originalMaster = config.MASTER_IDs;
    config.MASTER_IDs = ["master-user"];
    try {
      const result = await action_fn(
        {
          chatId: "setup-1",
          rootDb: db,
          senderIds: ["master-user"],
          getIsAdmin: async () => true,
          select: async () => selections.shift() ?? "",
        },
        {},
      );

      assert.ok(result.includes("enabled"), `Expected enabled summary, got: ${result}`);
      assert.ok(result.includes("mention+reply"), `Expected trigger summary, got: ${result}`);
      assert.ok(result.includes("codex"), `Expected harness summary, got: ${result}`);
      assert.ok(result.includes("gpt-5.4"), `Expected harness model summary, got: ${result}`);
      assert.ok(result.includes("danger-full-access"), `Expected permissions summary, got: ${result}`);
      assert.ok(result.includes("!clone"), `Expected clone hint, got: ${result}`);

      const chat = await readRequiredConfig("setup-1");
      const codexConfig = getScopedHarnessConfig(chat.harness_config, "codex");
      assert.equal(chat.is_enabled, true);
      assert.equal(chat.respond_on, "mention+reply");
      assert.equal(chat.memory, false, "setup should no longer modify memory");
      assert.equal(chat.debug, true);
      assert.equal(chat.harness, "codex");
      assert.equal(codexConfig.model, "gpt-5.4");
      assert.equal(codexConfig.sandboxMode, "danger-full-access");
    } finally {
      config.MASTER_IDs = originalMaster;
      await fs.rm(CODEX_CACHE_PATH, { force: true });
    }
  },

  async function skips_permissions_prompt_for_non_codex_harnesses(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id) VALUES ('setup-native') ON CONFLICT DO NOTHING`;
    await writeChatConfig("setup-native", {
      chat_id: "setup-native",
      is_enabled: false,
      respond_on: "mention",
      memory: false,
      debug: false,
      output_visibility: {},
    });

    /** @type {string[]} */
    const selections = ["mention+reply", "native"];

    const originalMaster = config.MASTER_IDs;
    config.MASTER_IDs = ["master-user"];
    try {
      const result = await action_fn(
        {
          chatId: "setup-native",
          rootDb: db,
          senderIds: ["master-user"],
          getIsAdmin: async () => true,
          select: async () => selections.shift() ?? "",
        },
        {},
      );

      assert.ok(result.includes("native"), `Expected harness summary, got: ${result}`);

      const chat = await readRequiredConfig("setup-native");
      assert.equal(chat.harness, null);
      assert.deepEqual(chat.harness_config ?? {}, {});
    } finally {
      config.MASTER_IDs = originalMaster;
    }
  },

  async function cancels_without_changing_anything(action_fn, db) {
    await db.sql`INSERT INTO chats(chat_id) VALUES ('setup-2') ON CONFLICT DO NOTHING`;
    await writeChatConfig("setup-2", {
      chat_id: "setup-2",
      is_enabled: false,
      respond_on: "mention",
      memory: false,
      debug: false,
      output_visibility: {},
    });

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

      const chat = await readRequiredConfig("setup-2");
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
