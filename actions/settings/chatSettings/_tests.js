import assert from "node:assert/strict";
import config from "../../../config.js";
import { withModelsCache } from "../../../tests/helpers.js";
import { readChatConfig, writeChatConfig } from "../../../chat-config.js";

/**
 * @param {ChatDb} db
 * @param {string} chatId
 * @param {Record<string, unknown>} [settings]
 */
async function seedConfigChat(db, chatId, settings = {}) {
  await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT DO NOTHING`;
  await writeChatConfig(chatId, { chat_id: chatId, ...settings });
}

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
// ── model ──
    async function sets_model_for_chat(action_fn, db) {
      await withModelsCache([
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await seedConfigChat(db, "cs-model-1");
        const result = await action_fn(
          { chatId: "cs-model-1", rootDb: db },
          { setting: "model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("openai/gpt-4o"));
        const chat = await readRequiredConfig("cs-model-1");
        assert.equal(chat.model, "openai/gpt-4o");
      });
    },
    async function reverts_model_to_default(action_fn, db) {
      await seedConfigChat(db, "cs-model-2", { model: "gpt-4o" });
      const result = await action_fn(
        { chatId: "cs-model-2", rootDb: db },
        { setting: "model", value: "" },
      );
      assert.ok(result.includes("default"));
      const chat = await readRequiredConfig("cs-model-2");
      assert.equal(chat.model, null);
    },
    async function gets_model_value(action_fn, db) {
      await seedConfigChat(db, "cs-model-3", { model: "custom/m" });
      const result = await action_fn(
        { chatId: "cs-model-3", rootDb: db },
        { setting: "model" },
      );
      assert.ok(result.includes("custom/m"));
    },
    async function gets_default_model(action_fn, db) {
      await seedConfigChat(db, "cs-model-4");
      const result = await action_fn(
        { chatId: "cs-model-4", rootDb: db },
        { setting: "model" },
      );
      assert.ok(result.includes("default"));
    },

    // ── system_prompt ──
    async function sets_system_prompt(action_fn, db) {
      await seedConfigChat(db, "cs-prompt-1");
      const result = await action_fn(
        { chatId: "cs-prompt-1", rootDb: db },
        { setting: "system_prompt", value: "Be a pirate" },
      );
      assert.ok(result.includes("pirate"));
      const chat = await readRequiredConfig("cs-prompt-1");
      assert.equal(chat.system_prompt, "Be a pirate");
    },
    async function clears_system_prompt(action_fn, db) {
      await seedConfigChat(db, "cs-prompt-2", { system_prompt: "old" });
      const result = await action_fn(
        { chatId: "cs-prompt-2", rootDb: db },
        { setting: "system_prompt", value: "  " },
      );
      assert.ok(result.toLowerCase().includes("clear") || result.toLowerCase().includes("default"));
      const chat = await readRequiredConfig("cs-prompt-2");
      assert.equal(chat.system_prompt, null);
    },
    async function gets_custom_prompt(action_fn, db) {
      await seedConfigChat(db, "cs-prompt-3", { system_prompt: "custom prompt" });
      const result = await action_fn(
        { chatId: "cs-prompt-3", rootDb: db },
        { setting: "system_prompt" },
      );
      assert.ok(result.includes("custom prompt"));
    },
    async function gets_default_prompt(action_fn, db) {
      await seedConfigChat(db, "cs-prompt-4");
      const result = await action_fn(
        { chatId: "cs-prompt-4", rootDb: db },
        { setting: "system_prompt" },
      );
      assert.ok(result.includes("default"));
    },

    // ── memory ──
    async function enables_memory(action_fn, db) {
      await seedConfigChat(db, "cs-mem-1");
      const result = await action_fn(
        { chatId: "cs-mem-1", rootDb: db },
        { setting: "memory", value: "true" },
      );
      const chat = await readRequiredConfig("cs-mem-1");
      assert.equal(chat.memory, true);
      assert.ok(result.toLowerCase().includes("enabled"));
    },
    async function disables_memory(action_fn, db) {
      await seedConfigChat(db, "cs-mem-2", { memory: true });
      const result = await action_fn(
        { chatId: "cs-mem-2", rootDb: db },
        { setting: "memory", value: "false" },
      );
      const chat = await readRequiredConfig("cs-mem-2");
      assert.equal(chat.memory, false);
      assert.ok(result.toLowerCase().includes("disabled"));
    },

    // ── memory_threshold ──
    async function sets_memory_threshold(action_fn, db) {
      await seedConfigChat(db, "cs-thresh-1");
      const result = await action_fn(
        { chatId: "cs-thresh-1", rootDb: db },
        { setting: "memory_threshold", value: "0.5" },
      );
      const chat = await readRequiredConfig("cs-thresh-1");
      assert.equal(chat.memory_threshold, 0.5);
      assert.ok(result.includes("0.5"));
    },
    async function rejects_out_of_range_threshold(action_fn, db) {
      await seedConfigChat(db, "cs-thresh-2");
      await assert.rejects(
        async () => action_fn({ chatId: "cs-thresh-2", rootDb: db }, { setting: "memory_threshold", value: "1.5" }),
      );
    },

    // ── trigger (respond_on) ──
    async function sets_trigger(action_fn, db) {
      await seedConfigChat(db, "cs-resp-1");
      const result = await action_fn(
        { chatId: "cs-resp-1", rootDb: db },
        { setting: "trigger", value: "mention+reply" },
      );
      assert.ok(result.includes("mention+reply"));
      const chat = await readRequiredConfig("cs-resp-1");
      assert.equal(chat.respond_on, "mention+reply");
    },
    async function rejects_invalid_trigger(action_fn, db) {
      await seedConfigChat(db, "cs-resp-2");
      const result = await action_fn(
        { chatId: "cs-resp-2", rootDb: db },
        { setting: "trigger", value: "invalid" },
      );
      assert.ok(result.includes("Invalid"));
    },

    // ── image_to_text_model ──
    async function sets_image_to_text_model(action_fn, db) {
      await withModelsCache([
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        await seedConfigChat(db, "cs-cm-1");
        const result = await action_fn(
          { chatId: "cs-cm-1", rootDb: db },
          { setting: "image_to_text_model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("image"));
        const chat = await readRequiredConfig("cs-cm-1");
        assert.equal(chat.media_to_text_models.image, "openai/gpt-4o");
      });
    },
    async function rejects_model_without_modality(action_fn, db) {
      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
      ], async () => {
        await seedConfigChat(db, "cs-cm-2");
        const result = await action_fn(
          { chatId: "cs-cm-2", rootDb: db },
          { setting: "image_to_text_model", value: "text-only/model" },
        );
        assert.ok(result.includes("does not support"));
      });
    },

    // ── media_to_text_model (general) ──
    async function sets_general_media_to_text_model(action_fn, db) {
      await withModelsCache([
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        await seedConfigChat(db, "cs-mtt-1");
        const result = await action_fn(
          { chatId: "cs-mtt-1", rootDb: db },
          { setting: "media_to_text_model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("media-to-text model"));
        const chat = await readRequiredConfig("cs-mtt-1");
        assert.equal(chat.media_to_text_models.general, "openai/gpt-4o");
      });
    },
    async function rejects_text_only_model_for_general_media_to_text(action_fn, db) {
      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
      ], async () => {
        await seedConfigChat(db, "cs-mtt-2");
        const result = await action_fn(
          { chatId: "cs-mtt-2", rootDb: db },
          { setting: "media_to_text_model", value: "text-only/model" },
        );
        assert.ok(result.includes("does not support"));
      });
    },
    async function gets_general_media_to_text_model(action_fn, db) {
      await seedConfigChat(db, "cs-mtt-3", { media_to_text_models: { general: "openai/gpt-4o" } });
      const result = await action_fn(
        { chatId: "cs-mtt-3", rootDb: db },
        { setting: "media_to_text_model" },
      );
      assert.ok(result.includes("openai/gpt-4o"));
    },

    // ── info summary when no setting provided ──
    async function shows_full_info_when_no_setting(action_fn, db) {
      await seedConfigChat(db, "cs-info-1", { is_enabled: true });
      const result = await action_fn(
        {
          chatId: "cs-info-1",
          rootDb: db,
          senderIds: ["user-1"],
          getIsAdmin: async () => false,
        },
        { setting: "" },
      );
      assert.ok(result.includes("cs-info-1"), "should include chat id");
      assert.ok(result.includes("enabled"), "should include status");
      assert.ok(result.includes("user-1"), "should include sender");
    },
    async function info_shows_model_and_default_label(action_fn, db) {
      await seedConfigChat(db, "cs-info-2");
      const result = await action_fn(
        { chatId: "cs-info-2", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes(config.model), "should include default model");
      assert.ok(result.includes("default"), "should indicate default");
    },
    async function info_shows_custom_model(action_fn, db) {
      await seedConfigChat(db, "cs-info-3", { model: "custom/model" });
      const result = await action_fn(
        { chatId: "cs-info-3", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("custom/model"));
    },
    async function info_shows_respond_on(action_fn, db) {
      await seedConfigChat(db, "cs-info-4", { respond_on: "mention+reply" });
      const result = await action_fn(
        { chatId: "cs-info-4", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("mention+reply"), "should include respond_on value");
    },
    async function info_shows_memory_settings(action_fn, db) {
      await seedConfigChat(db, "cs-info-5", { memory: true, memory_threshold: 0.5 });
      const result = await action_fn(
        { chatId: "cs-info-5", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.toLowerCase().includes("memory"), "should include memory");
      assert.ok(result.includes("0.5"), "should include threshold");
    },
    async function info_shows_debug_status(action_fn, db) {
      await seedConfigChat(db, "cs-info-6", { debug: true });
      const result = await action_fn(
        { chatId: "cs-info-6", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.toLowerCase().includes("debug"), "should include debug status");
      assert.ok(result.toLowerCase().includes("on"), "should show debug is on");
    },
    async function info_shows_media_to_text_models(action_fn, db) {
      await seedConfigChat(db, "cs-info-7", { media_to_text_models: { image: "openai/gpt-4o" } });
      const result = await action_fn(
        { chatId: "cs-info-7", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("openai/gpt-4o"), "should include media-to-text model");
      assert.ok(result.includes("image"), "should include media type");
    },
    // ── admin check for writes ──
    async function rejects_set_from_non_admin(action_fn, db) {
      await seedConfigChat(db, "cs-admin-1");
      const result = await action_fn(
        { chatId: "cs-admin-1", rootDb: db, getIsAdmin: async () => false },
        { setting: "memory", value: "true" },
      );
      assert.ok(result.includes("admin"), "should mention admin requirement");
    },
    async function allows_get_from_non_admin(action_fn, db) {
      await seedConfigChat(db, "cs-admin-2");
      const result = await action_fn(
        { chatId: "cs-admin-2", rootDb: db, getIsAdmin: async () => false },
        { setting: "memory" },
      );
      assert.ok(result.toLowerCase().includes("memory"), "should return memory setting");
    },

    // ── enabled (requires master) ──
    async function enables_chat_as_master(action_fn, db) {
      await seedConfigChat(db, "cs-en-1");
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-1", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "true" },
        );
        assert.ok(result.includes("enabled"));
        const chat = await readRequiredConfig("cs-en-1");
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function enables_other_chat_as_master(action_fn, db) {
      await seedConfigChat(db, "cs-admin-chat");
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-admin-chat", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "true cs-target-chat@g.us" },
        );
        assert.ok(result.includes("cs-target-chat@g.us"), `Expected target chat in response, got: ${result}`);
        const chat = await readRequiredConfig("cs-target-chat@g.us");
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function disables_chat_as_master(action_fn, db) {
      await seedConfigChat(db, "cs-en-2", { is_enabled: true });
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-2", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "false" },
        );
        assert.ok(result.includes("disabled"));
        const chat = await readRequiredConfig("cs-en-2");
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function rejects_enabled_from_non_master(action_fn, db) {
      await seedConfigChat(db, "cs-en-3");
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-3", rootDb: db, senderIds: ["regular-user"] },
          { setting: "enabled", value: "true" },
        );
        assert.ok(result.includes("master"), "should mention master requirement");
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function gets_enabled_status(action_fn, db) {
      await seedConfigChat(db, "cs-en-4", { is_enabled: true });
      const result = await action_fn(
        { chatId: "cs-en-4", rootDb: db },
        { setting: "enabled" },
      );
      assert.ok(result.includes("enabled"));
    },

    // ── debug ──
    async function enables_debug_on(action_fn, db) {
      await seedConfigChat(db, "cs-dbg-1");
      const result = await action_fn(
        { chatId: "cs-dbg-1", rootDb: db },
        { setting: "debug", value: "on" },
      );
      assert.ok(result.toLowerCase().includes("on"));

      const chat = await readRequiredConfig("cs-dbg-1");
      assert.equal(chat.debug, true);
    },
    async function disables_debug_with_off(action_fn, db) {
      await seedConfigChat(db, "cs-dbg-2", { debug: true });
      const result = await action_fn(
        { chatId: "cs-dbg-2", rootDb: db },
        { setting: "debug", value: "off" },
      );
      assert.ok(result.toLowerCase().includes("off"));

      const chat = await readRequiredConfig("cs-dbg-2");
      assert.equal(chat.debug, false);
    },
    async function gets_debug_status(action_fn, db) {
      await seedConfigChat(db, "cs-dbg-3", { debug: true });
      const result = await action_fn(
        { chatId: "cs-dbg-3", rootDb: db },
        { setting: "debug" },
      );
      assert.ok(result.toLowerCase().includes("debug"));
      assert.ok(result.toLowerCase().includes("on"));
    },

    // ── model role settings (coding_model, smart_model, etc.) ──
    async function sets_coding_model(action_fn, db) {
      await withModelsCache([
        { id: "deepseek/coder", name: "Deepseek Coder", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await seedConfigChat(db, "cs-role-1");
        const result = await action_fn(
          { chatId: "cs-role-1", rootDb: db },
          { setting: "coding_model", value: "deepseek/coder" },
        );
        assert.ok(result.includes("deepseek/coder"));
        const chat = await readRequiredConfig("cs-role-1");
        assert.equal(chat.model_roles.coding, "deepseek/coder");
      });
    },
    async function gets_coding_model(action_fn, db) {
      await seedConfigChat(db, "cs-role-2", { model_roles: { coding: "deepseek/coder" } });
      const result = await action_fn(
        { chatId: "cs-role-2", rootDb: db },
        { setting: "coding_model" },
      );
      assert.ok(result.includes("deepseek/coder"));
    },
    async function gets_default_coding_model(action_fn, db) {
      await seedConfigChat(db, "cs-role-3");
      const result = await action_fn(
        { chatId: "cs-role-3", rootDb: db },
        { setting: "coding_model" },
      );
      assert.ok(result.includes("not set") || result.includes("default"));
    },
    async function clears_coding_model(action_fn, db) {
      await seedConfigChat(db, "cs-role-4", { model_roles: { coding: "deepseek/coder" } });
      const result = await action_fn(
        { chatId: "cs-role-4", rootDb: db },
        { setting: "coding_model", value: "" },
      );
      assert.ok(result.includes("cleared") || result.includes("reverted") || result.includes("default"));
      const chat = await readRequiredConfig("cs-role-4");
      assert.equal(chat.model_roles.coding, undefined);
    },
    async function sets_image_generation_model(action_fn, db) {
      await withModelsCache([
        { id: "dalle-3", name: "DALL-E 3", context_length: 4096, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await seedConfigChat(db, "cs-role-5");
        const result = await action_fn(
          { chatId: "cs-role-5", rootDb: db },
          { setting: "image_generation_model", value: "dalle-3" },
        );
        assert.ok(result.includes("dalle-3"));
        const chat = await readRequiredConfig("cs-role-5");
        assert.equal(chat.model_roles.image_generation, "dalle-3");
      });
    },
    async function rejects_invalid_role_model(action_fn, db) {
      await withModelsCache([], async () => {
        await seedConfigChat(db, "cs-role-6");
        const result = await action_fn(
          { chatId: "cs-role-6", rootDb: db },
          { setting: "coding_model", value: "nonexistent/model" },
        );
        assert.ok(result.includes("not found") || result.includes("nvalid") || result.includes("error"), `Expected rejection, got: ${result}`);
      });
    },
    // ── harness_cwd ──
    async function rejects_nonexistent_harness_cwd(action_fn, db) {
      await seedConfigChat(db, "cs-cwd-1");
      const result = await action_fn(
        { chatId: "cs-cwd-1", rootDb: db },
        { setting: "harness_cwd", value: "/home/mada/totally_nonexistent_path_xyz" },
      );
      assert.ok(result.includes("does not exist"), `Expected rejection, got: ${result}`);
      // Should not have been saved
      const chat = await readRequiredConfig("cs-cwd-1");
      assert.equal(chat.harness_cwd, null);
    },
    async function suggests_similar_paths_for_bad_cwd(action_fn, db) {
      await seedConfigChat(db, "cs-cwd-2");
      // /home exists and has subdirectories, so suggestions should appear
      const result = await action_fn(
        { chatId: "cs-cwd-2", rootDb: db },
        { setting: "harness_cwd", value: "/home/nonexistent_user_xyz" },
      );
      assert.ok(result.includes("does not exist"), `Expected rejection, got: ${result}`);
      assert.ok(result.includes("Did you mean"), `Expected suggestions, got: ${result}`);
    },
    async function accepts_valid_harness_cwd(action_fn, db) {
      await seedConfigChat(db, "cs-cwd-3");
      const result = await action_fn(
        { chatId: "cs-cwd-3", rootDb: db },
        { setting: "harness_cwd", value: "/tmp" },
      );
      assert.ok(result.includes("set to"), `Expected success, got: ${result}`);
      const chat = await readRequiredConfig("cs-cwd-3");
      assert.equal(chat.harness_cwd, "/tmp");
    },
    async function clears_harness_cwd(action_fn, db) {
      await seedConfigChat(db, "cs-cwd-4", { harness_cwd: "/tmp" });
      const result = await action_fn(
        { chatId: "cs-cwd-4", rootDb: db },
        { setting: "harness_cwd", value: "" },
      );
      assert.ok(result.includes("cleared"), `Expected cleared, got: ${result}`);
      const chat = await readRequiredConfig("cs-cwd-4");
      assert.equal(chat.harness_cwd, null);
    },

    async function info_shows_role_overrides(action_fn, db) {
      await seedConfigChat(db, "cs-role-7", { model_roles: { coding: "deepseek/coder", fast: "gpt-4o-mini" } });
      const result = await action_fn(
        { chatId: "cs-role-7", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("deepseek/coder"), "should include coding model override");
      assert.ok(result.includes("gpt-4o-mini"), "should include fast model override");
    },
];
