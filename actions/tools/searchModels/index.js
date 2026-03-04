import { getCachedModels } from "../../../models-cache.js";

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
  formatToolCall: ({ providers, modality }) => {
    const parts = ["Searching models"];
    if (providers) parts.push(`by ${providers}`);
    if (modality) parts.push(`(${modality})`);
    return parts.join(" ");
  },
  permissions: {
    autoExecute: true
  },
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
