import assert from "node:assert/strict";
import config from "../../../config.js";
import { withModelsCache } from "../../../tests/helpers.js";

/** @type {ActionDbTestFn[]} */
export default [
// ── model ──
    async function sets_model_for_chat(action_fn, db) {
      await withModelsCache([
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-model-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-model-1", rootDb: db },
          { setting: "model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("openai/gpt-4o"));
        const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'cs-model-1'`;
        assert.equal(chat.model, "openai/gpt-4o");
      });
    },
    async function reverts_model_to_default(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('cs-model-2', 'gpt-4o') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-model-2", rootDb: db },
        { setting: "model", value: "" },
      );
      assert.ok(result.includes("default"));
      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'cs-model-2'`;
      assert.equal(chat.model, null);
    },
    async function gets_model_value(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('cs-model-3', 'custom/m') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-model-3", rootDb: db },
        { setting: "model" },
      );
      assert.ok(result.includes("custom/m"));
    },
    async function gets_default_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-model-4') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-model-4", rootDb: db },
        { setting: "model" },
      );
      assert.ok(result.includes("default"));
    },

    // ── system_prompt ──
    async function sets_system_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-prompt-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-1", rootDb: db },
        { setting: "system_prompt", value: "Be a pirate" },
      );
      assert.ok(result.includes("pirate"));
      const { rows: [chat] } = await db.sql`SELECT system_prompt FROM chats WHERE chat_id = 'cs-prompt-1'`;
      assert.equal(chat.system_prompt, "Be a pirate");
    },
    async function clears_system_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, system_prompt) VALUES ('cs-prompt-2', 'old') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-2", rootDb: db },
        { setting: "system_prompt", value: "  " },
      );
      assert.ok(result.toLowerCase().includes("clear") || result.toLowerCase().includes("default"));
      const { rows: [chat] } = await db.sql`SELECT system_prompt FROM chats WHERE chat_id = 'cs-prompt-2'`;
      assert.equal(chat.system_prompt, null);
    },
    async function gets_custom_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, system_prompt) VALUES ('cs-prompt-3', 'custom prompt') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-3", rootDb: db },
        { setting: "system_prompt" },
      );
      assert.ok(result.includes("custom prompt"));
    },
    async function gets_default_prompt(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-prompt-4') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-prompt-4", rootDb: db },
        { setting: "system_prompt" },
      );
      assert.ok(result.includes("default"));
    },

    // ── memory ──
    async function enables_memory(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mem-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-mem-1", rootDb: db },
        { setting: "memory", value: "true" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'cs-mem-1'`;
      assert.equal(chat.memory, true);
      assert.ok(result.toLowerCase().includes("enabled"));
    },
    async function disables_memory(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('cs-mem-2', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-mem-2", rootDb: db },
        { setting: "memory", value: "false" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'cs-mem-2'`;
      assert.equal(chat.memory, false);
      assert.ok(result.toLowerCase().includes("disabled"));
    },

    // ── memory_threshold ──
    async function sets_memory_threshold(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-thresh-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-thresh-1", rootDb: db },
        { setting: "memory_threshold", value: "0.5" },
      );
      const { rows: [chat] } = await db.sql`SELECT memory_threshold FROM chats WHERE chat_id = 'cs-thresh-1'`;
      assert.equal(chat.memory_threshold, 0.5);
      assert.ok(result.includes("0.5"));
    },
    async function rejects_out_of_range_threshold(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-thresh-2') ON CONFLICT DO NOTHING`;
      await assert.rejects(
        async () => action_fn({ chatId: "cs-thresh-2", rootDb: db }, { setting: "memory_threshold", value: "1.5" }),
      );
    },

    // ── trigger (respond_on) ──
    async function sets_trigger(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-resp-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-resp-1", rootDb: db },
        { setting: "trigger", value: "mention+reply" },
      );
      assert.ok(result.includes("mention+reply"));
      const { rows: [chat] } = await db.sql`SELECT respond_on FROM chats WHERE chat_id = 'cs-resp-1'`;
      assert.equal(chat.respond_on, "mention+reply");
    },
    async function rejects_invalid_trigger(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-resp-2') ON CONFLICT DO NOTHING`;
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
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-cm-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-cm-1", rootDb: db },
          { setting: "image_to_text_model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("image"));
        const { rows: [chat] } = await db.sql`SELECT media_to_text_models FROM chats WHERE chat_id = 'cs-cm-1'`;
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
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-cm-2') ON CONFLICT DO NOTHING`;
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
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mtt-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-mtt-1", rootDb: db },
          { setting: "media_to_text_model", value: "openai/gpt-4o" },
        );
        assert.ok(result.includes("media-to-text model"));
        const { rows: [chat] } = await db.sql`SELECT media_to_text_models FROM chats WHERE chat_id = 'cs-mtt-1'`;
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
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mtt-2') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-mtt-2", rootDb: db },
          { setting: "media_to_text_model", value: "text-only/model" },
        );
        assert.ok(result.includes("does not support"));
      });
    },
    async function gets_general_media_to_text_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-mtt-3') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET media_to_text_models = '{"general":"openai/gpt-4o"}'::jsonb WHERE chat_id = 'cs-mtt-3'`;
      const result = await action_fn(
        { chatId: "cs-mtt-3", rootDb: db },
        { setting: "media_to_text_model" },
      );
      assert.ok(result.includes("openai/gpt-4o"));
    },

    // ── info summary when no setting provided ──
    async function shows_full_info_when_no_setting(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('cs-info-1', true) ON CONFLICT DO NOTHING`;
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
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-info-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-2", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes(config.model), "should include default model");
      assert.ok(result.includes("default"), "should indicate default");
    },
    async function info_shows_custom_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('cs-info-3', 'custom/model') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-3", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("custom/model"));
    },
    async function info_shows_respond_on(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, respond_on)
        VALUES ('cs-info-4', 'mention+reply') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-4", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("mention+reply"), "should include respond_on value");
    },
    async function info_shows_memory_settings(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, memory, memory_threshold) VALUES ('cs-info-5', true, 0.5) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-5", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.toLowerCase().includes("memory"), "should include memory");
      assert.ok(result.includes("0.5"), "should include threshold");
    },
    async function info_shows_debug_status(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, debug) VALUES ('cs-info-6', TRUE) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-6", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.toLowerCase().includes("debug"), "should include debug status");
      assert.ok(result.toLowerCase().includes("on"), "should show debug is on");
    },
    async function info_shows_media_to_text_models(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-info-7') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET media_to_text_models = '{"image":"openai/gpt-4o"}'::jsonb WHERE chat_id = 'cs-info-7'`;
      const result = await action_fn(
        { chatId: "cs-info-7", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("openai/gpt-4o"), "should include media-to-text model");
      assert.ok(result.includes("image"), "should include media type");
    },
    async function info_shows_enabled_opt_in_actions(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-info-8', '["track_purchases"]'::jsonb) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-8", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("track_purchases"), "should include enabled opt-in action");
    },
    async function info_shows_none_when_no_opt_in_actions(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-info-9') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-info-9", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("none"), "should show none for opt-in actions");
    },

    // ── admin check for writes ──
    async function rejects_set_from_non_admin(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-admin-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-admin-1", rootDb: db, getIsAdmin: async () => false },
        { setting: "memory", value: "true" },
      );
      assert.ok(result.includes("admin"), "should mention admin requirement");
    },
    async function allows_get_from_non_admin(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-admin-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-admin-2", rootDb: db, getIsAdmin: async () => false },
        { setting: "memory" },
      );
      assert.ok(result.toLowerCase().includes("memory"), "should return memory setting");
    },

    // ── enabled (requires master) ──
    async function enables_chat_as_master(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-en-1') ON CONFLICT DO NOTHING`;
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-1", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "true" },
        );
        assert.ok(result.includes("enabled"));
        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'cs-en-1'`;
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function enables_other_chat_as_master(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-admin-chat') ON CONFLICT DO NOTHING`;
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-admin-chat", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "true cs-target-chat@g.us" },
        );
        assert.ok(result.includes("cs-target-chat@g.us"), `Expected target chat in response, got: ${result}`);
        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'cs-target-chat@g.us'`;
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function disables_chat_as_master(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('cs-en-2', true) ON CONFLICT DO NOTHING`;
      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const result = await action_fn(
          { chatId: "cs-en-2", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "false" },
        );
        assert.ok(result.includes("disabled"));
        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'cs-en-2'`;
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    },
    async function rejects_enabled_from_non_master(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-en-3') ON CONFLICT DO NOTHING`;
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
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('cs-en-4', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-en-4", rootDb: db },
        { setting: "enabled" },
      );
      assert.ok(result.includes("enabled"));
    },

    // ── debug ──
    async function enables_debug_on(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-dbg-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-dbg-1", rootDb: db },
        { setting: "debug", value: "on" },
      );
      assert.ok(result.toLowerCase().includes("on"));

      const { rows: [chat] } = await db.sql`SELECT debug FROM chats WHERE chat_id = 'cs-dbg-1'`;
      assert.equal(chat.debug, true);
    },
    async function disables_debug_with_off(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, debug) VALUES ('cs-dbg-2', TRUE) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-dbg-2", rootDb: db },
        { setting: "debug", value: "off" },
      );
      assert.ok(result.toLowerCase().includes("off"));

      const { rows: [chat] } = await db.sql`SELECT debug FROM chats WHERE chat_id = 'cs-dbg-2'`;
      assert.equal(chat.debug, false);
    },
    async function gets_debug_status(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, debug) VALUES ('cs-dbg-3', TRUE) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-dbg-3", rootDb: db },
        { setting: "debug" },
      );
      assert.ok(result.toLowerCase().includes("debug"));
      assert.ok(result.toLowerCase().includes("on"));
    },

    // ── actions (opt-in) ──
    async function enables_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-1') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => /** @type {Action[]} */ ([
        { name: "test_opt", optIn: true },
      ]);
      const result = await action_fn(
        { chatId: "cs-act-1", rootDb: db, getActions: mockGetActions },
        { setting: "actions", value: "test_opt true" },
      );
      assert.ok(result.includes("enabled"));
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'cs-act-1'`;
      assert.ok(chat.enabled_actions.includes("test_opt"));
    },
    async function disables_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-act-2', '["test_opt"]'::jsonb) ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => /** @type {Action[]} */ ([
        { name: "test_opt", optIn: true },
      ]);
      const result = await action_fn(
        { chatId: "cs-act-2", rootDb: db, getActions: mockGetActions },
        { setting: "actions", value: "test_opt false" },
      );
      assert.ok(result.includes("disabled"));
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'cs-act-2'`;
      assert.ok(!chat.enabled_actions.includes("test_opt"));
    },
    async function rejects_non_opt_in_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-3') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => /** @type {Action[]} */ ([
        { name: "regular_action" },
      ]);
      const result = await action_fn(
        { chatId: "cs-act-3", rootDb: db, getActions: mockGetActions },
        { setting: "actions", value: "regular_action true" },
      );
      assert.ok(result.includes("not an opt-in action"));
    },
    async function rejects_unknown_action(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-4') ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => /** @type {Action[]} */ ([]);
      const result = await action_fn(
        { chatId: "cs-act-4", rootDb: db, getActions: mockGetActions },
        { setting: "actions", value: "nonexistent true" },
      );
      assert.ok(result.includes("not found"));
    },
    async function does_not_duplicate_on_double_enable(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-act-5', '["test_opt"]'::jsonb) ON CONFLICT DO NOTHING`;
      const mockGetActions = async () => /** @type {Action[]} */ ([
        { name: "test_opt", optIn: true },
      ]);
      await action_fn(
        { chatId: "cs-act-5", rootDb: db, getActions: mockGetActions },
        { setting: "actions", value: "test_opt true" },
      );
      const { rows: [chat] } = await db.sql`SELECT enabled_actions FROM chats WHERE chat_id = 'cs-act-5'`;
      const count = chat.enabled_actions.filter(/** @param {string} a */ (a) => a === "test_opt").length;
      assert.equal(count, 1);
    },
    async function shows_action_usage_when_missing_args(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-act-6') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-act-6", rootDb: db, getActions: async () => [] },
        { setting: "actions", value: "just_one_arg" },
      );
      assert.ok(result.includes("Usage"));
    },
    async function gets_enabled_actions_list(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, enabled_actions) VALUES ('cs-act-7', '["track_purchases"]'::jsonb) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-act-7", rootDb: db },
        { setting: "action" },
      );
      assert.ok(result.includes("track_purchases"));
    },

    // ── model role settings (coding_model, smart_model, etc.) ──
    async function sets_coding_model(action_fn, db) {
      await withModelsCache([
        { id: "deepseek/coder", name: "Deepseek Coder", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-1') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-role-1", rootDb: db },
          { setting: "coding_model", value: "deepseek/coder" },
        );
        assert.ok(result.includes("deepseek/coder"));
        const { rows: [chat] } = await db.sql`SELECT model_roles FROM chats WHERE chat_id = 'cs-role-1'`;
        assert.equal(chat.model_roles.coding, "deepseek/coder");
      });
    },
    async function gets_coding_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-2') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET model_roles = '{"coding":"deepseek/coder"}'::jsonb WHERE chat_id = 'cs-role-2'`;
      const result = await action_fn(
        { chatId: "cs-role-2", rootDb: db },
        { setting: "coding_model" },
      );
      assert.ok(result.includes("deepseek/coder"));
    },
    async function gets_default_coding_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-3') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-role-3", rootDb: db },
        { setting: "coding_model" },
      );
      assert.ok(result.includes("not set") || result.includes("default"));
    },
    async function clears_coding_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-4') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET model_roles = '{"coding":"deepseek/coder"}'::jsonb WHERE chat_id = 'cs-role-4'`;
      const result = await action_fn(
        { chatId: "cs-role-4", rootDb: db },
        { setting: "coding_model", value: "" },
      );
      assert.ok(result.includes("cleared") || result.includes("reverted") || result.includes("default"));
      const { rows: [chat] } = await db.sql`SELECT model_roles FROM chats WHERE chat_id = 'cs-role-4'`;
      assert.equal(chat.model_roles.coding, undefined);
    },
    async function sets_image_generation_model(action_fn, db) {
      await withModelsCache([
        { id: "dalle-3", name: "DALL-E 3", context_length: 4096, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-5') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-role-5", rootDb: db },
          { setting: "image_generation_model", value: "dalle-3" },
        );
        assert.ok(result.includes("dalle-3"));
        const { rows: [chat] } = await db.sql`SELECT model_roles FROM chats WHERE chat_id = 'cs-role-5'`;
        assert.equal(chat.model_roles.image_generation, "dalle-3");
      });
    },
    async function rejects_invalid_role_model(action_fn, db) {
      await withModelsCache([], async () => {
        await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-6') ON CONFLICT DO NOTHING`;
        const result = await action_fn(
          { chatId: "cs-role-6", rootDb: db },
          { setting: "coding_model", value: "nonexistent/model" },
        );
        assert.ok(result.includes("not found") || result.includes("nvalid") || result.includes("error"), `Expected rejection, got: ${result}`);
      });
    },
    // ── harness_cwd ──
    async function rejects_nonexistent_harness_cwd(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-cwd-1') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-cwd-1", rootDb: db },
        { setting: "harness_cwd", value: "/home/mada/totally_nonexistent_path_xyz" },
      );
      assert.ok(result.includes("does not exist"), `Expected rejection, got: ${result}`);
      // Should not have been saved
      const { rows: [chat] } = await db.sql`SELECT harness_cwd FROM chats WHERE chat_id = 'cs-cwd-1'`;
      assert.equal(chat.harness_cwd, null);
    },
    async function suggests_similar_paths_for_bad_cwd(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-cwd-2') ON CONFLICT DO NOTHING`;
      // /home exists and has subdirectories, so suggestions should appear
      const result = await action_fn(
        { chatId: "cs-cwd-2", rootDb: db },
        { setting: "harness_cwd", value: "/home/nonexistent_user_xyz" },
      );
      assert.ok(result.includes("does not exist"), `Expected rejection, got: ${result}`);
      assert.ok(result.includes("Did you mean"), `Expected suggestions, got: ${result}`);
    },
    async function accepts_valid_harness_cwd(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-cwd-3') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-cwd-3", rootDb: db },
        { setting: "harness_cwd", value: "/tmp" },
      );
      assert.ok(result.includes("set to"), `Expected success, got: ${result}`);
      const { rows: [chat] } = await db.sql`SELECT harness_cwd FROM chats WHERE chat_id = 'cs-cwd-3'`;
      assert.equal(chat.harness_cwd, "/tmp");
    },
    async function clears_harness_cwd(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, harness_cwd) VALUES ('cs-cwd-4', '/tmp') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "cs-cwd-4", rootDb: db },
        { setting: "harness_cwd", value: "" },
      );
      assert.ok(result.includes("cleared"), `Expected cleared, got: ${result}`);
      const { rows: [chat] } = await db.sql`SELECT harness_cwd FROM chats WHERE chat_id = 'cs-cwd-4'`;
      assert.equal(chat.harness_cwd, null);
    },

    async function info_shows_role_overrides(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('cs-role-7') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET model_roles = '{"coding":"deepseek/coder","fast":"gpt-4o-mini"}'::jsonb WHERE chat_id = 'cs-role-7'`;
      const result = await action_fn(
        { chatId: "cs-role-7", rootDb: db, senderIds: ["u1"], getIsAdmin: async () => false },
        { setting: "" },
      );
      assert.ok(result.includes("deepseek/coder"), "should include coding model override");
      assert.ok(result.includes("gpt-4o-mini"), "should include fast model override");
    },
];
