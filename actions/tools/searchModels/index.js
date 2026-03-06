import { getCachedModels } from "../../../models-cache.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "search_models",
  command: "search models",
  description: "Search LLM models from the cached OpenRouter model list with pricing and context information. Searches across model id, name, description, and modality string. Can also filter by supported input modality (image, audio, video, file).",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to match against model id, name, description, and modality (e.g., 'claude', 'code', 'image->text', 'fast')"
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
  formatToolCall: ({ query, modality }) => {
    const parts = ["Searching models"];
    if (query) parts.push(`for "${query}"`);
    if (modality) parts.push(`(${modality})`);
    return parts.join(" ");
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /**
   * @param {ActionContext} _context
   * @param {{ query?: string, modality?: string, sortBy?: string }} params
   */
  action_fn: async function (_context, params) {
    if (!params.query && !params.modality) {
      return "Please provide at least one filter: query (e.g. 'claude', 'code generation') or modality (e.g. 'video', 'image', 'audio').";
    }

    const queryTerms = params.query
      ? params.query.toLowerCase().split(/\s+/)
      : [];
    const modality = params.modality?.trim().toLowerCase();

    const filters = [];
    if (queryTerms.length > 0) filters.push(`query: "${params.query}"`);
    if (modality) filters.push(`modality: ${modality}`);
    const data = await getCachedModels();

    if (data.length === 0) {
      return "No cached models available. The cache may not have been populated yet — try again shortly.";
    }

    const TOKENS_PER_MILLION = 1_000_000;

    /** @param {import("../../../models-cache.js").OpenRouterModel} model */
    function matchesQuery(model) {
      if (queryTerms.length === 0) return true;
      const searchable = [
        model.id,
        model.name,
        model.description,
        model.architecture?.modality ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return queryTerms.every(term => searchable.includes(term));
    }

    const models = data
      .filter(model => {
        if (!matchesQuery(model)) return false;
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
        modality: model.architecture?.modality || "text->text",
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

    let table = "*IN* | *OUT* | *CTX* | *MODALITY* | *MODEL* | *ID*\n";
    table += "------------------------------------------------------------\n";
    for (const model of models) {
      table += `• $${model.inputPrice.toFixed(2)} | $${model.outputPrice.toFixed(2)} | ${model.contextDisplay} | ${model.modality} | *${model.name}* | \`${model.id}\`\n`;
    }

    return table;
  }
});
