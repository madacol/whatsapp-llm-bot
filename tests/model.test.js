import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestDb } from "./helpers.js";
import config from "../config.js";

const CACHE_PATH = path.resolve("data/models.json");

/** @type {import("../models-cache.js").OpenRouterModel[]} */
const fakeModels = [
  { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
];

async function writeFakeCache() {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(fakeModels));
}

describe("per-chat model selection", () => {
  /** @type {import("@electric-sql/pglite").PGlite} */
  let db;

  before(async () => {
    db = await createTestDb();
    await writeFakeCache();
  });

  after(async () => {
    await fs.rm(CACHE_PATH, { force: true });
  });

  describe("store layer – model column", () => {
    it("model column exists in chats table", async () => {
      const { rows } = await db.sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chats' AND column_name = 'model'
      `;
      assert.equal(rows.length, 1);
    });

    it("getChat returns model value after it is set via SQL", async () => {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('test-chat-1', 'gpt-4.1') ON CONFLICT DO NOTHING`;
      const { rows: [chat] } = await db.sql`SELECT * FROM chats WHERE chat_id = 'test-chat-1'`;
      assert.equal(chat.model, "gpt-4.1");
    });

    it("model defaults to null when not set", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('test-chat-2') ON CONFLICT DO NOTHING`;
      const { rows: [chat] } = await db.sql`SELECT * FROM chats WHERE chat_id = 'test-chat-2'`;
      assert.equal(chat.model, null);
    });
  });

  describe("chat_settings info includes model", () => {
    it("shows custom model in info output", async () => {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('chat-get-1', 'claude-sonnet-4-5-20250929') ON CONFLICT DO NOTHING`;

      const settingsModule = await import("../actions/settings/chatSettings.js");
      const action = settingsModule.default;
      const result = await action.action_fn(
        { chatId: "chat-get-1", rootDb: db, senderIds: ["u1"] },
        { setting: "" },
      );
      assert.ok(result.includes("claude-sonnet-4-5-20250929"));
    });

    it("indicates default when model is not set", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-get-2') ON CONFLICT DO NOTHING`;

      const settingsModule = await import("../actions/settings/chatSettings.js");
      const action = settingsModule.default;
      const result = await action.action_fn(
        { chatId: "chat-get-2", rootDb: db, senderIds: ["u1"] },
        { setting: "" },
      );
      assert.ok(result.includes("default"));
    });

    it("throws if chat does not exist", async () => {
      const settingsModule = await import("../actions/settings/chatSettings.js");
      const action = settingsModule.default;
      await assert.rejects(
        () => action.action_fn({ chatId: "nonexistent", rootDb: db, senderIds: [] }, { setting: "" }),
        { message: /does not exist/ },
      );
    });
  });

  describe("chat_settings model via dispatch", () => {
    it("updates the model in the DB", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-1') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-1", rootDb: db },
        { setting: "model", value: "openai/gpt-4.1-mini" },
      );
      assert.ok(result.includes("openai/gpt-4.1-mini"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-1'`;
      assert.equal(chat.model, "openai/gpt-4.1-mini");
    });

    it("reverts to default when given empty string", async () => {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('chat-set-2', 'some-model') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-2", rootDb: db },
        { setting: "model", value: "" },
      );
      assert.ok(result.includes("default"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-2'`;
      assert.equal(chat.model, null);
    });

    it("rejects invalid model with suggestions", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-3') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-3", rootDb: db },
        { setting: "model", value: "nonexistent/fake-model" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-3'`;
      assert.equal(chat.model, null);
    });

    it("suggests close matches for partial model names", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-4') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "chat-set-4", rootDb: db },
        { setting: "model", value: "gpt-4" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));
      assert.ok(result.includes("openai/gpt-4"));
    });

    it("throws if chat does not exist", async () => {
      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      await assert.rejects(
        () => action.action_fn({ chatId: "nonexistent", rootDb: db }, { setting: "model", value: "x" }),
        { message: /does not exist/ },
      );
    });
  });

  describe("toBool accepts 'on'/'off' for boolean settings", () => {
    it("'on' enables memory", async () => {
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('mem-on-1', false) ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "on" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);

      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'mem-on-1'`;
      assert.equal(chat.memory, true);
    });

    it("'off' disables memory", async () => {
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('mem-off-1', true) ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-off-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "off" },
      );
      assert.ok(result.includes("disabled"), `expected 'disabled' in: ${result}`);

      const { rows: [chat] } = await db.sql`SELECT memory FROM chats WHERE chat_id = 'mem-off-1'`;
      assert.equal(chat.memory, false);
    });

    it("'true' still works", async () => {
      await db.sql`INSERT INTO chats(chat_id, memory) VALUES ('mem-true-1', false) ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "mem-true-1", rootDb: db, senderIds: ["u1"] },
        { setting: "memory", value: "true" },
      );
      assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);
    });

    it("throws on unrecognized boolean value", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('mem-bad-1') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      await assert.rejects(
        () => action.action_fn(
          { chatId: "mem-bad-1", rootDb: db, senderIds: ["u1"] },
          { setting: "memory", value: "banana" },
        ),
        { message: /must be one of.*on.*off.*true.*false/i },
      );
    });
  });

  describe("debug 'on' enables debug", () => {
    it("'on' enables debug with default duration", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('dbg-on-1') ON CONFLICT DO NOTHING`;

      const mod = await import("../actions/settings/chatSettings.js");
      const action = mod.default;
      const result = await action.action_fn(
        { chatId: "dbg-on-1", rootDb: db, senderIds: ["u1"] },
        { setting: "debug", value: "on" },
      );
      assert.ok(result.includes("Debug on"), `expected 'Debug on' in: ${result}`);

      const { rows: [chat] } = await db.sql`SELECT debug_until FROM chats WHERE chat_id = 'dbg-on-1'`;
      assert.ok(chat.debug_until !== null, "debug_until should be set");
    });
  });

  describe("enabled setting accepts 'enabled'/'disabled'", () => {
    it("'enabled' enables the bot", async () => {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('en-1', false) ON CONFLICT DO NOTHING`;

      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const mod = await import("../actions/settings/chatSettings.js");
        const action = mod.default;
        const result = await action.action_fn(
          { chatId: "en-1", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "enabled" },
        );
        assert.ok(result.includes("enabled"), `expected 'enabled' in: ${result}`);

        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'en-1'`;
        assert.equal(chat.is_enabled, true);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });

    it("'disabled' disables the bot", async () => {
      await db.sql`INSERT INTO chats(chat_id, is_enabled) VALUES ('en-2', true) ON CONFLICT DO NOTHING`;

      const originalMaster = config.MASTER_IDs;
      config.MASTER_IDs = ["master-user"];
      try {
        const mod = await import("../actions/settings/chatSettings.js");
        const action = mod.default;
        const result = await action.action_fn(
          { chatId: "en-2", rootDb: db, senderIds: ["master-user"] },
          { setting: "enabled", value: "disabled" },
        );
        assert.ok(result.includes("disabled"), `expected 'disabled' in: ${result}`);

        const { rows: [chat] } = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = 'en-2'`;
        assert.equal(chat.is_enabled, false);
      } finally {
        config.MASTER_IDs = originalMaster;
      }
    });
  });

  describe("model resolution logic", () => {
    it("uses custom model when present", () => {
      const chatInfo = { model: "custom-model" };
      const configModel = "default-model";
      const resolved = chatInfo.model || configModel;
      assert.equal(resolved, "custom-model");
    });

    it("falls back to config model when chat model is null", () => {
      const chatInfo = { model: null };
      const configModel = "default-model";
      const resolved = chatInfo.model || configModel;
      assert.equal(resolved, "default-model");
    });

    it("falls back to config model when chatInfo is undefined", () => {
      const chatInfo = undefined;
      const configModel = "default-model";
      const resolved = chatInfo?.model || configModel;
      assert.equal(resolved, "default-model");
    });
  });
});
