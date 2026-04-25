import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";

const log = createLogger("harness:codex-models");
const CACHE_PATH = path.resolve("data/codex-models.json");
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

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
 *   slug: string,
 *   display_name: string,
 *   visibility?: string,
 * }} RawCodexCatalogModel
 */

/**
 * @param {unknown} value
 * @returns {value is RawCodexCatalogModel}
 */
function isRawCodexCatalogModel(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  return typeof value.slug === "string"
    && typeof value.display_name === "string"
    && (value.visibility === undefined || typeof value.visibility === "string");
}

/**
 * @param {unknown} value
 * @returns {value is { models: RawCodexCatalogModel[] }}
 */
function isRawCodexCatalog(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  return Array.isArray(value.models) && value.models.every(isRawCodexCatalogModel);
}

/**
 * @typedef {{
 *   readFile?: typeof fs.readFile,
 *   writeFile?: typeof fs.writeFile,
 *   mkdir?: typeof fs.mkdir,
 *   stat?: typeof fs.stat,
 *   now?: () => number,
 *   readModelCatalog?: () => Promise<string>,
 * }} CodexModelDeps
 */

/**
 * @returns {Promise<string>}
 */
async function readLiveCodexModelCatalog() {
  const { stdout } = await execFileAsync("codex", ["debug", "models"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * @param {string} rawCatalog
 * @returns {Array<{ id: string, label: string }> | null}
 */
function parseCodexModelCatalog(rawCatalog) {
  try {
    const parsed = JSON.parse(rawCatalog);
    if (!isRawCodexCatalog(parsed)) {
      return null;
    }
    return parsed.models
      .filter((model) => model.visibility !== "hide")
      .map((model) => ({ id: model.slug, label: model.display_name }));
  } catch {
    return null;
  }
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
 * @param {CodexModelDeps} [deps]
 * @returns {Promise<Array<{ id: string, label: string }>>}
 */
export async function getCodexAvailableModels(deps = {}) {
  if (await cacheIsFresh(deps)) {
    const cache = await readCache(deps);
    if (cache) {
      return cache.models;
    }
  }

  const staleCache = await readCache(deps);
  const readModelCatalog = deps.readModelCatalog ?? readLiveCodexModelCatalog;
  try {
    const availableModels = parseCodexModelCatalog(await readModelCatalog());
    if (availableModels) {
      const checkedAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
      await writeCache({ checkedAt, models: availableModels }, deps);
      return availableModels;
    }
    log.warn("Codex model catalog had an unexpected shape; falling back to cache.");
  } catch (error) {
    log.warn("Failed to load Codex model catalog:", error);
  }

  if (staleCache) {
    return staleCache.models;
  }

  return [];
}
