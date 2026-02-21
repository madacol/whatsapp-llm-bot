import assert from "node:assert/strict";
import { getCachedModels } from "../models-cache.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "search_models",
  command: "search models",
  description: "Search LLM models from the cached OpenRouter model list with pricing and context information",
  parameters: {
    type: "object",
    properties: {
      providers: {
        type: "string",
        description: "Comma-separated list of providers to filter by (e.g., 'glm-4.7,claude,codex,kimi-k2.5')"
      },
      sortBy: {
        type: "string",
        description: "Sort results by: input_price, output_price, or context (default: input_price)"
      }
    },
    required: ["providers"]
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
      /** @type {import("../models-cache.js").OpenRouterModel[]} */
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
  ],
  /**
   * @param {ActionContext} context
   * @param {{ providers: string, sortBy?: string }} params
   */
  action_fn: async function (context, params) {
    const filterPatterns = params.providers
      .split(',')
      .map(provider => provider.trim().toLowerCase());

    await context.log(`Starting model comparison for providers: ${filterPatterns.join(", ")}`);

    const data = await getCachedModels();

    if (data.length === 0) {
      return "No cached models available. The cache may not have been populated yet — try again shortly.";
    }

    const TOKENS_PER_MILLION = 1_000_000;

    const models = data
      .filter(model =>
        filterPatterns.some(pattern => model.id.toLowerCase().includes(pattern))
      )
      .map(model => ({
        id: model.id,
        name: model.name,
        contextLength: model.context_length,
        contextDisplay: Math.round(model.context_length / 1000) + 'k',
        inputPrice: parseFloat(model.pricing.prompt) * TOKENS_PER_MILLION,
        outputPrice: parseFloat(model.pricing.completion) * TOKENS_PER_MILLION,
      }));

    const sortBy = params.sortBy || 'input_price';
    if (sortBy === "input_price") {
      models.sort((left, right) => left.inputPrice - right.inputPrice);
    } else if (sortBy === "output_price") {
      models.sort((left, right) => left.outputPrice - right.outputPrice);
    } else if (sortBy === "context") {
      models.sort((left, right) => right.contextLength - left.contextLength);
    }

    await context.log(`Found ${models.length} models matching criteria`);

    let table = "*IN* | *OUT* | *CTX* | *MODEL* | *ID*\n";
    table += "------------------------------------------------------------\n";
    for (const model of models) {
      table += `• $${model.inputPrice.toFixed(2)} | $${model.outputPrice.toFixed(2)} | ${model.contextDisplay} | *${model.name}* | \`${model.id}\`\n`;
    }

    await context.log("Model comparison complete");
    return table;
  }
});
