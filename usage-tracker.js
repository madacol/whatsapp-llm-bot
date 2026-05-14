import { getCachedModels } from "./models-cache.js";
import { isSqliteDb } from "./sqlite-db.js";

/**
 * Estimate cost using cached model pricing from OpenRouter.
 * @param {string} model
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {Promise<number | null>} Estimated cost or null if model not found
 */
export async function estimateCost(model, promptTokens, completionTokens) {
  const models = await getCachedModels();
  const entry = models.find((m) => m.id === model);
  if (!entry) return null;
  const promptCost = parseFloat(entry.pricing.prompt);
  const completionCost = parseFloat(entry.pricing.completion);
  return promptTokens * promptCost + completionTokens * completionCost;
}

/**
 * Resolve cost: prefer native (OpenRouter) cost, fall back to estimate.
 * @param {number | undefined} nativeCost
 * @param {string} model
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {Promise<number | null>}
 */
export async function resolveCost(nativeCost, model, promptTokens, completionTokens) {
  if (typeof nativeCost === "number") return nativeCost;
  return estimateCost(model, promptTokens, completionTokens);
}

/**
 * @typedef {import("@electric-sql/pglite").PGlite} PGlite
 */

/** @type {WeakSet<PGlite | import("./sqlite-db.js").SqliteDb>} */
const initialized = new WeakSet();

/**
 * Ensure the usage_logs table exists.
 * @param {PGlite | import("./sqlite-db.js").SqliteDb} db
 */
async function ensureSchema(db) {
  if (isSqliteDb(db)) {
    await db.sql`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;
    return;
  }

  await db.sql`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      chat_id VARCHAR(50) NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost DOUBLE PRECISION,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

/**
 * Lazy-init schema (once per db instance).
 * @param {PGlite | import("./sqlite-db.js").SqliteDb} db
 */
async function init(db) {
  if (initialized.has(db)) return;
  await ensureSchema(db);
  initialized.add(db);
}

/**
 * @typedef {{
 *   chatId: string,
 *   model: string,
 *   promptTokens: number,
 *   completionTokens: number,
 *   cachedTokens: number,
 *   cost: number | null,
 * }} UsageRecord
 */

/**
 * Record an LLM usage entry.
 * @param {PGlite | import("./sqlite-db.js").SqliteDb} db
 * @param {UsageRecord} record
 */
export async function recordUsage(db, record) {
  await init(db);
  await db.sql`
    INSERT INTO usage_logs (chat_id, model, prompt_tokens, completion_tokens, cached_tokens, cost)
    VALUES (${record.chatId}, ${record.model}, ${record.promptTokens}, ${record.completionTokens}, ${record.cachedTokens}, ${record.cost})
  `;
}
