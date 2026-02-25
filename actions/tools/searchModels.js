import assert from "node:assert/strict";
import { getCachedModels } from "../../models-cache.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "search_models",
  command: "search models",
  description: "Search LLM models from the cached OpenRouter model list with pricing and context information. Can filter by provider name and/or supported input modality (image, audio, video, file).",
  parameters: {
    type: "object",
    properties: {
      providers: {
        type: "string",
        description: "Comma-separated list of providers to filter by (e.g., 'glm-4.7,claude,codex,kimi-k2.5')"
      },
      modality: {
        type: "string",
        description: "Filter by supported input modality: image, audio, video, or file"
      },
      sortBy: {
        type: "string",
        description: "Sort results by: input_price, output_price, or context (default: input_price)"
      }
    },
  },
  permissions: {
    autoExecute: true
  },
  test_functions: [
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
  ],
  /**
   * @param {ActionContext} context
   * @param {{ providers?: string, modality?: string, sortBy?: string }} params
   */
  action_fn: async function (context, params) {
    if (!params.providers && !params.modality) {
      return "Please provide at least one filter: providers (e.g. 'google,openai') or modality (e.g. 'video', 'image', 'audio').";
    }

    const filterPatterns = params.providers
      ? params.providers.split(',').map(p => p.trim().toLowerCase())
      : [];
    const modality = params.modality?.trim().toLowerCase();

    const filters = [];
    if (filterPatterns.length > 0) filters.push(`providers: ${filterPatterns.join(", ")}`);
    if (modality) filters.push(`modality: ${modality}`);
    await context.log(`Searching models — ${filters.join(", ")}`);

    const data = await getCachedModels();

    if (data.length === 0) {
      return "No cached models available. The cache may not have been populated yet — try again shortly.";
    }

    const TOKENS_PER_MILLION = 1_000_000;

    const models = data
      .filter(model => {
        if (filterPatterns.length > 0 && !filterPatterns.some(p => model.id.toLowerCase().includes(p))) {
          return false;
        }
        if (modality && !(model.architecture?.input_modalities || []).includes(modality)) {
          return false;
        }
        return true;
      })
      .map(model => ({
        id: model.id,
        name: model.name,
        contextLength: model.context_length,
        contextDisplay: Math.round(model.context_length / 1000) + 'k',
        inputPrice: parseFloat(model.pricing.prompt) * TOKENS_PER_MILLION,
        outputPrice: parseFloat(model.pricing.completion) * TOKENS_PER_MILLION,
        modalities: model.architecture?.input_modalities || ["text"],
      }));

    const sortBy = params.sortBy || 'input_price';
    if (sortBy === "input_price") {
      models.sort((left, right) => left.inputPrice - right.inputPrice);
    } else if (sortBy === "output_price") {
      models.sort((left, right) => left.outputPrice - right.outputPrice);
    } else if (sortBy === "context") {
      models.sort((left, right) => right.contextLength - left.contextLength);
    }

    if (models.length === 0) {
      return `No models found matching the given filters (${filters.join(", ")}).`;
    }

    await context.log(`Found ${models.length} models matching criteria`);

    let table = modality
      ? "*IN* | *OUT* | *CTX* | *MODEL* | *ID* | *MODALITIES*\n"
      : "*IN* | *OUT* | *CTX* | *MODEL* | *ID*\n";
    table += "------------------------------------------------------------\n";
    for (const model of models) {
      if (modality) {
        const mods = model.modalities.filter(m => m !== "text").join(", ");
        table += `• $${model.inputPrice.toFixed(2)} | $${model.outputPrice.toFixed(2)} | ${model.contextDisplay} | *${model.name}* | \`${model.id}\` | ${mods}\n`;
      } else {
        table += `• $${model.inputPrice.toFixed(2)} | $${model.outputPrice.toFixed(2)} | ${model.contextDisplay} | *${model.name}* | \`${model.id}\`\n`;
      }
    }

    await context.log("Model comparison complete");
    return table;
  }
});
