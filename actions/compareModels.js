/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   context_length: number,
 *   pricing: { prompt: string, completion: string }
 * }} OpenRouterModel
 */

export default /** @type {defineAction} */ ((x) => x)({
  name: "compare_models",
  command: "compare-models",
  description: "Fetch and compare LLM models from OpenRouter with pricing and context information",
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
