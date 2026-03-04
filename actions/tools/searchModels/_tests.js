import assert from "node:assert/strict";

/** @type {ActionDbTestFn[]} */
export default [
async function searches_across_multiple_columns(action_fn, _db) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");

      // Write a fake cache file for the test
      /** @type {import("../../../models-cache.js").OpenRouterModel[]} */
      const fakeModels = [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          description: "A fast multimodal model",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
        },
        {
          id: "anthropic/claude-3.5-sonnet",
          name: "Claude 3.5 Sonnet",
          description: "Great for code and reasoning",
          context_length: 200000,
          pricing: { prompt: "0.000003", completion: "0.000015" },
        },
      ];
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(fakeModels));

      try {
        // Search by id substring
        const byId = await action_fn(
          { log: async () => "" },
          { query: "gpt-4o" },
        );
        assert.ok(byId.includes("GPT-4o"));
        assert.ok(!byId.includes("Claude"));

        // Search by description content
        const byDesc = await action_fn(
          { log: async () => "" },
          { query: "reasoning" },
        );
        assert.ok(byDesc.includes("Claude 3.5 Sonnet"));
        assert.ok(!byDesc.includes("GPT-4o"));

        // Search matching both models
        const broad = await action_fn(
          { log: async () => "" },
          { query: "model" },
        );
        // "model" doesn't appear in id/name/description of either, so no results
        // Actually "multimodal" contains "model" — GPT-4o matches
        assert.ok(broad.includes("GPT-4o"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    },
    async function filters_by_modality(action_fn, _db) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");

      /** @type {import("../../../models-cache.js").OpenRouterModel[]} */
      const fakeModels = [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          description: "Multimodal model",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image", "audio"] },
        },
        {
          id: "google/gemini-3-flash",
          name: "Gemini 3 Flash",
          description: "Fast and versatile",
          context_length: 1000000,
          pricing: { prompt: "0.000001", completion: "0.000004" },
          architecture: { input_modalities: ["text", "image", "video", "audio"] },
        },
        {
          id: "anthropic/claude-3.5-sonnet",
          name: "Claude 3.5 Sonnet",
          description: "Great for code",
          context_length: 200000,
          pricing: { prompt: "0.000003", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ];
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(fakeModels));

      try {
        // Filter by video — only Gemini supports it
        const videoResult = await action_fn(
          { log: async () => "" },
          { modality: "video" },
        );
        assert.ok(videoResult.includes("Gemini 3 Flash"), `Should include Gemini, got: ${videoResult}`);
        assert.ok(!videoResult.includes("GPT-4o"), `Should NOT include GPT-4o, got: ${videoResult}`);
        assert.ok(!videoResult.includes("Claude"), `Should NOT include Claude, got: ${videoResult}`);

        // Filter by audio — GPT-4o and Gemini
        const audioResult = await action_fn(
          { log: async () => "" },
          { modality: "audio" },
        );
        assert.ok(audioResult.includes("GPT-4o"));
        assert.ok(audioResult.includes("Gemini 3 Flash"));
        assert.ok(!audioResult.includes("Claude"));

        // Combine query + modality
        const combinedResult = await action_fn(
          { log: async () => "" },
          { query: "google", modality: "video" },
        );
        assert.ok(combinedResult.includes("Gemini 3 Flash"));
        assert.ok(!combinedResult.includes("GPT-4o"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    },
];
