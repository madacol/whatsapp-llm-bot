import assert from "node:assert/strict";

export default [
async function formats_model_comparison_table(action_fn, _db) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");

      // Write a fake cache file for the test
      /** @type {import("../../models-cache.js").OpenRouterModel[]} */
      const fakeModels = [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
        },
        {
          id: "anthropic/claude-3.5-sonnet",
          name: "Claude 3.5 Sonnet",
          context_length: 200000,
          pricing: { prompt: "0.000003", completion: "0.000015" },
        },
      ];
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(fakeModels));

      try {
        const result = await action_fn(
          { log: async () => "" },
          { providers: "gpt-4o,claude" },
        );
        assert.ok(result.includes("GPT-4o"));
        assert.ok(result.includes("Claude 3.5 Sonnet"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    },
    async function filters_by_modality(action_fn, _db) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");

      /** @type {import("../../models-cache.js").OpenRouterModel[]} */
      const fakeModels = [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image", "audio"] },
        },
        {
          id: "google/gemini-3-flash",
          name: "Gemini 3 Flash",
          context_length: 1000000,
          pricing: { prompt: "0.000001", completion: "0.000004" },
          architecture: { input_modalities: ["text", "image", "video", "audio"] },
        },
        {
          id: "anthropic/claude-3.5-sonnet",
          name: "Claude 3.5 Sonnet",
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

        // Combine modality + providers
        const combinedResult = await action_fn(
          { log: async () => "" },
          { providers: "google", modality: "video" },
        );
        assert.ok(combinedResult.includes("Gemini 3 Flash"));
        assert.ok(!combinedResult.includes("GPT-4o"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    },
];
