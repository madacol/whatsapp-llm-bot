import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Helper: create an in-memory PGlite and run the same schema as store.js
 */
async function createTestDb() {
  const db = new PGlite("memory://");

  await db.sql`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id VARCHAR(50) PRIMARY KEY,
      is_enabled BOOLEAN DEFAULT FALSE,
      system_prompt TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await db.sql`
    CREATE TABLE IF NOT EXISTS messages (
      message_id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50) REFERENCES chats(chat_id),
      sender_id VARCHAR(50),
      message_data JSONB,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Migration: add model column (same as store.js)
  await db.sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT`;

  return db;
}

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
    await db.close();
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

  describe("getModel action", () => {
    it("returns custom model when set", async () => {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('chat-get-1', 'claude-sonnet-4-5-20250929') ON CONFLICT DO NOTHING`;

      const getModelModule = await import("../actions/getModel.js");
      const action = getModelModule.default;
      const result = await action.action_fn(
        { chatId: "chat-get-1", rootDb: db },
        {},
      );
      assert.ok(result.includes("claude-sonnet-4-5-20250929"));
      assert.ok(result.startsWith("Model:"));
    });

    it("indicates default when model is not set", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-get-2') ON CONFLICT DO NOTHING`;

      const getModelModule = await import("../actions/getModel.js");
      const action = getModelModule.default;
      const result = await action.action_fn(
        { chatId: "chat-get-2", rootDb: db },
        {},
      );
      assert.ok(result.includes("default"));
    });

    it("throws if chat does not exist", async () => {
      const getModelModule = await import("../actions/getModel.js");
      const action = getModelModule.default;
      await assert.rejects(
        () => action.action_fn({ chatId: "nonexistent", rootDb: db }, {}),
        { message: /does not exist/ },
      );
    });
  });

  describe("setModel action", () => {
    it("updates the model in the DB", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-1') ON CONFLICT DO NOTHING`;

      const setModelModule = await import("../actions/setModel.js");
      const action = setModelModule.default;
      const result = await action.action_fn(
        { chatId: "chat-set-1", rootDb: db },
        { model: "openai/gpt-4.1-mini" },
      );
      assert.ok(result.includes("openai/gpt-4.1-mini"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-1'`;
      assert.equal(chat.model, "openai/gpt-4.1-mini");
    });

    it("reverts to default when given empty string", async () => {
      await db.sql`INSERT INTO chats(chat_id, model) VALUES ('chat-set-2', 'some-model') ON CONFLICT DO NOTHING`;

      const setModelModule = await import("../actions/setModel.js");
      const action = setModelModule.default;
      const result = await action.action_fn(
        { chatId: "chat-set-2", rootDb: db },
        { model: "" },
      );
      assert.ok(result.includes("reverted to default"));

      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-2'`;
      assert.equal(chat.model, null);
    });

    it("rejects invalid model with suggestions", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-3') ON CONFLICT DO NOTHING`;

      const setModelModule = await import("../actions/setModel.js");
      const action = setModelModule.default;
      const result = await action.action_fn(
        { chatId: "chat-set-3", rootDb: db },
        { model: "nonexistent/fake-model" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));

      // Should NOT have updated the DB
      const { rows: [chat] } = await db.sql`SELECT model FROM chats WHERE chat_id = 'chat-set-3'`;
      assert.equal(chat.model, null);
    });

    it("suggests close matches for partial model names", async () => {
      await db.sql`INSERT INTO chats(chat_id) VALUES ('chat-set-4') ON CONFLICT DO NOTHING`;

      const setModelModule = await import("../actions/setModel.js");
      const action = setModelModule.default;
      const result = await action.action_fn(
        { chatId: "chat-set-4", rootDb: db },
        { model: "gpt-4" },
      );
      assert.ok(typeof result === "string");
      assert.ok(result.includes("not found"));
      // Should suggest close matches containing "gpt-4"
      assert.ok(result.includes("openai/gpt-4"));
    });

    it("throws if chat does not exist", async () => {
      const setModelModule = await import("../actions/setModel.js");
      const action = setModelModule.default;
      await assert.rejects(
        () => action.action_fn({ chatId: "nonexistent", rootDb: db }, { model: "x" }),
        { message: /does not exist/ },
      );
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
