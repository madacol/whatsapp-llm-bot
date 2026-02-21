import fs from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   context_length: number,
 *   pricing: { prompt: string, completion: string },
 *   architecture?: { input_modalities?: string[] }
 * }} OpenRouterModel
 */

const CACHE_PATH = path.resolve("data/models.json");
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch models from OpenRouter API and write to cache file.
 */
async function refreshCache() {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    console.error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    return;
  }
  /** @type {{ data: OpenRouterModel[] }} */
  const { data } = await response.json();
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(data));
}

/**
 * Check if the cache file needs refreshing (missing or older than 24h).
 * @returns {Promise<boolean>}
 */
async function cacheIsStale() {
  try {
    const stat = await fs.stat(CACHE_PATH);
    return Date.now() - stat.mtimeMs > REFRESH_INTERVAL_MS;
  } catch {
    return true; // file doesn't exist
  }
}

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
 * Check if a model ID exists in the cache.
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
export async function modelExists(modelId) {
  const models = await getCachedModels();
  return models.some((m) => m.id === modelId);
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
 * Get the input modalities supported by a model.
 * @param {string} modelId
 * @returns {Promise<string[]>} Array of supported input modalities (defaults to ["text"])
 */
export async function getModelModalities(modelId) {
  const models = await getCachedModels();
  const model = models.find((m) => m.id === modelId);
  return model?.architecture?.input_modalities ?? ["text"];
}

/**
 * Start the models cache daemon. Fetches immediately if stale, then refreshes every 24h.
 * @returns {() => void} Stop function to clear the interval
 */
export function startModelsCacheDaemon() {
  // Fetch immediately if stale (async, non-blocking)
  cacheIsStale().then((stale) => {
    if (stale) {
      refreshCache().catch((err) =>
        console.error("Models cache refresh error:", err),
      );
    }
  });

  const interval = setInterval(async () => {
    try {
      await refreshCache();
    } catch (error) {
      console.error("Models cache daemon refresh error:", error);
    }
  }, REFRESH_INTERVAL_MS);

  return () => clearInterval(interval);
}
