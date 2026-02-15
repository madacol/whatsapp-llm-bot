/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   context_length: number,
 *   pricing: { prompt: string, completion: string }
 * }} OpenRouterModel
 */

import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "list_models",
  command: "list models",
  description: "List LLM models from OpenRouter with pricing and context information",
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
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {any} */ (async () => ({
          json: async () => ({
            data: [
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
            ],
          }),
        }));
        const result = await action_fn(
          { log: async () => "" },
          { providers: "gpt-4o,claude" },
        );
        assert.ok(result.includes("GPT-4o"));
        assert.ok(result.includes("Claude 3.5 Sonnet"));
      } finally {
        globalThis.fetch = originalFetch;
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

    const response = await fetch('https://openrouter.ai/api/v1/models');
    /** @type {{ data: OpenRouterModel[] }} */
    const { data } = await response.json();

    const models = data
      .filter(model =>
        filterPatterns.some(pattern => model.id.toLowerCase().includes(pattern))
      )
      .map(model => ({
        id: model.id,
        name: model.name,
        contextSize: Math.round(model.context_length / 1024) + 'k',
        inputPrice: parseFloat(model.pricing.prompt) * 1000000,
        outputPrice: parseFloat(model.pricing.completion) * 1000000
      }));

    const sortBy = params.sortBy || 'input_price';
    if (sortBy === "input_price") {
      models.sort((left, right) => left.inputPrice - right.inputPrice);
    } else if (sortBy === "output_price") {
      models.sort((left, right) => left.outputPrice - right.outputPrice);
    } else if (sortBy === "context") {
      models.sort((left, right) => parseInt(right.contextSize) - parseInt(left.contextSize));
    }

    await context.log(`Found ${models.length} models matching criteria`);

    let table = "*IN* | *OUT* | *CTX* | *MODEL* | *ID*\n";
    table += "------------------------------------------------------------\n";
    for (const model of models) {
      table += `• $${model.inputPrice.toFixed(2)} | $${model.outputPrice.toFixed(2)} | ${model.contextSize} | *${model.name}* | \`${model.id}\`\n`;
    }

    await context.log("Model comparison complete");
    return table;
  }
});
