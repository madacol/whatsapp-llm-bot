import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const CACHE_PATH = path.resolve("data/models.json");

/**
 * Helper: write a fake cache file with the given models array and optional mtime.
 * @param {import("../models-cache.js").OpenRouterModel[]} models
 */
async function writeFakeCache(models) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(models));
}

async function removeCache() {
  await fs.rm(CACHE_PATH, { force: true });
}

describe("models-cache", () => {
  afterEach(async () => {
    await removeCache();
  });

  describe("getCachedModels", () => {
    it("returns parsed models from cache file", async () => {
      /** @type {import("../models-cache.js").OpenRouterModel[]} */
      const fakeModels = [
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
        { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
      ];
      await writeFakeCache(fakeModels);

      const { getCachedModels } = await import("../models-cache.js");
      const models = await getCachedModels();
      assert.equal(models.length, 2);
      assert.equal(models[0].id, "openai/gpt-4o");
      assert.equal(models[1].id, "anthropic/claude-3.5-sonnet");
    });

    it("returns empty array when cache file does not exist", async () => {
      await removeCache();
      const { getCachedModels } = await import("../models-cache.js");
      const models = await getCachedModels();
      assert.deepEqual(models, []);
    });
  });

  describe("modelExists", () => {
    it("returns true for an existing model id", async () => {
      await writeFakeCache([
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ]);
      const { modelExists } = await import("../models-cache.js");
      assert.equal(await modelExists("openai/gpt-4o"), true);
    });

    it("returns false for a non-existing model id", async () => {
      await writeFakeCache([
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
      ]);
      const { modelExists } = await import("../models-cache.js");
      assert.equal(await modelExists("nonexistent/model"), false);
    });

    it("returns false when cache is empty", async () => {
      await removeCache();
      const { modelExists } = await import("../models-cache.js");
      assert.equal(await modelExists("openai/gpt-4o"), false);
    });
  });

  describe("findClosestModels", () => {
    it("returns models whose ids contain the search term", async () => {
      await writeFakeCache([
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.000005", completion: "0.000015" } },
        { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
        { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
      ]);
      const { findClosestModels } = await import("../models-cache.js");
      const matches = await findClosestModels("gpt-4o");
      assert.ok(matches.length >= 2);
      assert.ok(matches.every((m) => m.includes("gpt-4o")));
    });

    it("returns at most 5 results", async () => {
      const models = Array.from({ length: 10 }, (_, i) => ({
        id: `provider/model-${i}`,
        name: `Model ${i}`,
        context_length: 4096,
        pricing: { prompt: "0.000001", completion: "0.000001" },
      }));
      await writeFakeCache(models);
      const { findClosestModels } = await import("../models-cache.js");
      const matches = await findClosestModels("model");
      assert.ok(matches.length <= 5);
    });
  });

  describe("startModelsCacheDaemon", () => {
    it("fetches immediately when cache file is missing", async () => {
      await removeCache();

      /** @type {import("../models-cache.js").OpenRouterModel[]} */
      const fakeModels = [
        { id: "test/model-1", name: "Test Model", context_length: 4096, pricing: { prompt: "0.000001", completion: "0.000001" } },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = /** @type {any} */ (async () => ({
        ok: true,
        json: async () => ({ data: fakeModels }),
      }));

      try {
        // Re-import to get fresh module
        const { startModelsCacheDaemon, getCachedModels } = await import("../models-cache.js");
        const stop = startModelsCacheDaemon();

        // Give it a moment to write the file
        await new Promise((r) => setTimeout(r, 200));

        const models = await getCachedModels();
        assert.equal(models.length, 1);
        assert.equal(models[0].id, "test/model-1");

        stop();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
