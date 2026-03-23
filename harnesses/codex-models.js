import fs from "node:fs/promises";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { createLogger } from "../logger.js";

const log = createLogger("harness:codex-models");
const CACHE_PATH = path.resolve("data/codex-models.json");
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** @type {string[]} */
const CANDIDATE_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5-codex",
  "gpt-5.3-codex",
  "codex-mini-latest",
  "gpt-5.4-codex",
];

/**
 * @typedef {{
 *   checkedAt: string,
 *   models: Array<{ id: string, label: string }>,
 * }} CodexModelsCache
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is { id: string, label: string }}
 */
function isCodexModelOption(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  return typeof value.id === "string" && typeof value.label === "string";
}

/**
 * @param {unknown} value
 * @returns {value is CodexModelsCache}
 */
function isCodexModelsCache(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  return typeof value.checkedAt === "string"
    && Array.isArray(value.models)
    && value.models.every(isCodexModelOption);
}

/**
 * @typedef {{
 *   readFile?: typeof fs.readFile,
 *   writeFile?: typeof fs.writeFile,
 *   mkdir?: typeof fs.mkdir,
 *   stat?: typeof fs.stat,
 *   now?: () => number,
 *   probeModel?: (modelId: string) => Promise<boolean>,
 * }} CodexModelDeps
 */

/**
 * @param {string} modelId
 * @returns {string}
 */
function formatModelLabel(modelId) {
  if (modelId === "gpt-5.4") return "GPT-5.4";
  if (modelId === "gpt-5.4-mini") return "GPT-5.4 Mini";
  if (modelId === "gpt-5-codex") return "GPT-5 Codex";
  if (modelId === "gpt-5.3-codex") return "GPT-5.3 Codex";
  if (modelId === "codex-mini-latest") return "Codex Mini Latest";
  return modelId;
}

/**
 * @param {CodexModelDeps} deps
 * @returns {Promise<CodexModelsCache | null>}
 */
async function readCache(deps) {
  const readFile = deps.readFile ?? fs.readFile;
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (isCodexModelsCache(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {CodexModelsCache} cache
 * @param {CodexModelDeps} deps
 * @returns {Promise<void>}
 */
async function writeCache(cache, deps) {
  const mkdir = deps.mkdir ?? fs.mkdir;
  const writeFile = deps.writeFile ?? fs.writeFile;
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache), "utf8");
}

/**
 * @param {CodexModelDeps} deps
 * @returns {Promise<boolean>}
 */
async function cacheIsFresh(deps) {
  const stat = deps.stat ?? fs.stat;
  const now = deps.now ?? Date.now;
  try {
    const fileStat = await stat(CACHE_PATH);
    return now() - fileStat.mtimeMs <= REFRESH_INTERVAL_MS;
  } catch {
    return false;
  }
}

/**
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
async function probeCodexModel(modelId) {
  const codex = new Codex();
  const thread = codex.startThread({
    model: modelId,
    skipGitRepoCheck: true,
  });
  try {
    await thread.run("Reply with ok.");
    return true;
  } catch (error) {
    log.debug(`Codex model probe failed for ${modelId}:`, error);
    return false;
  }
}

/**
 * @param {CodexModelDeps} [deps]
 * @returns {Promise<Array<{ id: string, label: string }>>}
 */
export async function getCodexAvailableModels(deps = {}) {
  if (await cacheIsFresh(deps)) {
    const cache = await readCache(deps);
    if (cache && cache.models.length > 0) {
      return cache.models;
    }
  }

  const staleCache = await readCache(deps);
  const probeModel = deps.probeModel ?? probeCodexModel;
  /** @type {Array<{ id: string, label: string }>} */
  const availableModels = [];

  for (const modelId of CANDIDATE_MODELS) {
    if (await probeModel(modelId)) {
      availableModels.push({ id: modelId, label: formatModelLabel(modelId) });
    }
  }

  if (availableModels.length > 0) {
    const checkedAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
    await writeCache({ checkedAt, models: availableModels }, deps);
    return availableModels;
  }

  if (staleCache && staleCache.models.length > 0) {
    return staleCache.models;
  }

  return [];
}
