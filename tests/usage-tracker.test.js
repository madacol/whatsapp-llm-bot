process.env.TESTING = "1";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { withModelsCache } from "./helpers.js";
import { recordUsage, estimateCost, resolveCost } from "../usage-tracker.js";

describe("usage-tracker", () => {
  /** @type {PGlite} */
  let db;

  before(async () => {
    db = new PGlite("memory://");
  });

  after(async () => {
    await db.close();
  });

  describe("estimateCost", () => {
    it("returns correct cost from cached pricing", async () => {
      const models = [
        {
          id: "test/model-a",
          name: "Model A",
          context_length: 4096,
          pricing: { prompt: "0.001", completion: "0.002" },
        },
      ];
      await withModelsCache(models, async () => {
        // 100 prompt tokens * $0.001/token + 50 completion tokens * $0.002/token = 0.2
        const cost = await estimateCost("test/model-a", 100, 50);
        assert.equal(cost, 0.2);
      });
    });

    it("returns null for unknown model", async () => {
      const models = [
        {
          id: "test/model-a",
          name: "Model A",
          context_length: 4096,
          pricing: { prompt: "0.001", completion: "0.002" },
        },
      ];
      await withModelsCache(models, async () => {
        const cost = await estimateCost("nonexistent/model", 100, 50);
        assert.equal(cost, null);
      });
    });
  });

  describe("resolveCost", () => {
    it("prefers native cost when available", async () => {
      const cost = await resolveCost(0.005, "any-model", 100, 50);
      assert.equal(cost, 0.005);
    });

    it("handles native cost of 0 (free/cached)", async () => {
      const cost = await resolveCost(0, "any-model", 100, 50);
      assert.equal(cost, 0);
    });

    it("falls back to estimateCost when native cost is undefined", async () => {
      const models = [
        {
          id: "test/model-b",
          name: "Model B",
          context_length: 4096,
          pricing: { prompt: "0.001", completion: "0.002" },
        },
      ];
      await withModelsCache(models, async () => {
        const cost = await resolveCost(undefined, "test/model-b", 100, 50);
        assert.equal(cost, 0.2);
      });
    });

    it("returns null when native cost is undefined and model not found", async () => {
      const models = [];
      await withModelsCache(models, async () => {
        const cost = await resolveCost(undefined, "nonexistent/model", 100, 50);
        assert.equal(cost, null);
      });
    });
  });

  describe("recordUsage", () => {
    it("persists a usage row with all fields", async () => {
      await recordUsage(db, {
        chatId: "chat-1",
        model: "test/model",
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 20,
        cost: 0.005,
      });

      const { rows } = await db.query(
        "SELECT * FROM usage_logs WHERE chat_id = $1",
        ["chat-1"],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].chat_id, "chat-1");
      assert.equal(rows[0].model, "test/model");
      assert.equal(rows[0].prompt_tokens, 100);
      assert.equal(rows[0].completion_tokens, 50);
      assert.equal(rows[0].cached_tokens, 20);
      assert.equal(rows[0].cost, 0.005);
      assert.ok(rows[0].created_at instanceof Date);
    });

    it("persists null cost when cost is not available", async () => {
      await recordUsage(db, {
        chatId: "chat-2",
        model: "test/model",
        promptTokens: 50,
        completionTokens: 25,
        cachedTokens: 0,
        cost: null,
      });

      const { rows } = await db.query(
        "SELECT * FROM usage_logs WHERE chat_id = $1",
        ["chat-2"],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].cost, null);
    });
  });
});
