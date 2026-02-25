import assert from "node:assert/strict";
import config from "../../config.js";
import { getChatOrThrow } from "../../store.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "show_info",
  command: "info",
  description: "Show information about the current chat: status, model, prompt, response modes, memory, debug, and content models.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  permissions: {
    autoExecute: true,
    useRootDb: true,
  },
  test_functions: [
    async function returns_chat_info(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('act-info-1', true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        {
          chatId: "act-info-1",
          rootDb: db,
          senderIds: ["user-1"],
          content: [{ type: "text", text: "!info" }],
        },
        {},
      );
      assert.ok(result.includes("act-info-1"));
      assert.ok(result.includes("enabled"));
      assert.ok(result.includes("user-1"));
    },
    async function shows_model_and_default_label(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-info-2') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-info-2", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(result.includes(config.model), "should include default model");
      assert.ok(result.includes("default"), "should indicate default");
    },
    async function shows_custom_model(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('act-info-3', 'custom/model') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-info-3", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(result.includes("custom/model"));
      assert.ok(!result.includes("(default)") || !result.match(/Model:.*default/));
    },
    async function shows_prompt_as_default_or_custom(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-info-4') ON CONFLICT DO NOTHING`;
      const defaultResult = await action_fn(
        { chatId: "act-info-4", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(defaultResult.toLowerCase().includes("default"), "should say default prompt");

      await db.sql`UPDATE chats SET system_prompt = 'my custom prompt' WHERE chat_id = 'act-info-4'`;
      const customResult = await action_fn(
        { chatId: "act-info-4", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(customResult.toLowerCase().includes("custom"), "should say custom prompt");
    },
    async function shows_response_modes(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, respond_on_any, respond_on_mention, respond_on_reply)
        VALUES ('act-info-5', true, false, true) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-info-5", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(result.includes("any"), "should include respond_on_any");
      assert.ok(result.includes("reply"), "should include respond_on_reply");
    },
    async function shows_memory_settings(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, memory, memory_threshold) VALUES ('act-info-6', true, 0.5) ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-info-6", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(result.toLowerCase().includes("memory"), "should include memory");
      assert.ok(result.includes("0.5"), "should include threshold");
    },
    async function shows_debug_status(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id, debug_until) VALUES ('act-info-7', '9999-01-01') ON CONFLICT DO NOTHING`;
      const result = await action_fn(
        { chatId: "act-info-7", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(result.toLowerCase().includes("debug"), "should include debug status");
      assert.ok(result.toLowerCase().includes("on"), "should show debug is on");
    },
    async function shows_content_models(action_fn, db) {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('act-info-8') ON CONFLICT DO NOTHING`;
      await db.sql`UPDATE chats SET content_models = '{"image":"openai/gpt-4o"}'::jsonb WHERE chat_id = 'act-info-8'`;
      const result = await action_fn(
        { chatId: "act-info-8", rootDb: db, senderIds: ["u1"] },
        {},
      );
      assert.ok(result.includes("openai/gpt-4o"), "should include content model");
      assert.ok(result.includes("image"), "should include content type");
    },
  ],
  action_fn: async function ({ chatId, rootDb, senderIds }) {
    const chat = await getChatOrThrow(rootDb, chatId);

    const status = chat.is_enabled ? "enabled" : "disabled";
    const model = chat.model || `${config.model} (default)`;
    const prompt = chat.system_prompt ? "custom (!get prompt)" : "default";

    /** @type {string[]} */
    const respondModes = [];
    if (chat.respond_on_any) respondModes.push("any");
    if (chat.respond_on_mention) respondModes.push("mention");
    if (chat.respond_on_reply) respondModes.push("reply");
    const response = respondModes.join(", ") || "none";

    const memoryOn = chat.memory ? "on" : "off";
    const threshold = chat.memory_threshold ?? config.memory_threshold;

    const debugOn = chat.debug_until && new Date(chat.debug_until) > new Date();
    const debug = debugOn ? "on" : "off";

    const contentModels = chat.content_models ?? {};
    const contentModelEntries = Object.entries(contentModels);
    const contentStr = contentModelEntries.length > 0
      ? contentModelEntries.map(([type, m]) => `${type}: ${m}`).join(", ")
      : "default";

    const lines = [
      `*Chat:* ${chatId}`,
      `*Status:* ${status}`,
      `*Sender:* ${senderIds.join(", ")}`,
      `*Model:* ${model}`,
      `*Prompt:* ${prompt}`,
      `*Response:* ${response}`,
      `*Memory:* ${memoryOn} (threshold: ${threshold})`,
      `*Debug:* ${debug}`,
      `*Content models:* ${contentStr}`,
    ];

    return lines.join("\n");
  },
});
