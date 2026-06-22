import fs from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   context_length: number,
 *   pricing: { prompt: string, completion: string },
 *   architecture?: { modality?: string, input_modalities?: string[] }
 * }} OpenRouterModel
 */

const CACHE_PATH = path.resolve("data/models.json");

/**
 * Read cached models from the file.
 * @returns {Promise<OpenRouterModel[]>}
 */
export async function getCachedModels() {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Find model IDs that contain the search term (for suggestions).
 * @param {string} search
 * @param {number} [limit=5]
 * @returns {Promise<string[]>}
 */
export async function findClosestModels(search, limit = 5) {
  const models = await getCachedModels();
  const term = search.toLowerCase();
  return models
    .filter((m) => m.id.toLowerCase().includes(term))
    .slice(0, limit)
    .map((m) => m.id);
}

/**
 * Validate that a model ID exists in the cache.
 * @param {string} modelId
 * @returns {Promise<string | null>} null if valid, or a user-facing error message if not found
 */
export async function validateModel(modelId) {
  const models = await getCachedModels();
  if (models.some((m) => m.id === modelId)) {
    return null;
  }
  const term = modelId.toLowerCase();
  const suggestions = models
    .filter((m) => m.id.toLowerCase().includes(term))
    .slice(0, 5)
    .map((m) => m.id);
  let message = `Model \`${modelId}\` not found in OpenRouter models.`;
  if (suggestions.length > 0) {
    message += `\n\nDid you mean:\n${suggestions.map((s) => `• \`${s}\``).join("\n")}`;
  }
  message += `\n\nUse *!search models* to browse available models.`;
  return message;
}

/**
 * Get the input modalities supported by a model.
 * @param {string} modelId
 * @returns {Promise<string[]>} Array of supported input modalities (defaults to ["text"])
 */
export async function getModelModalities(modelId) {
  const models = await getCachedModels();
  const model = models.find((m) => m.id === modelId);
  return model?.architecture?.input_modalities ?? ["text"];
}
