const TOKENS_PER_MILLION = 1_000_000;

/**
 * Published standard text-token prices for Codex-compatible OpenAI models.
 * Values are USD per 1M tokens.
 * @typedef {{
 *   input: number,
 *   cachedInput: number,
 *   output: number,
 * }} CodexTokenRates
 */

/** @type {Readonly<Record<string, CodexTokenRates>>} */
const CODEX_TOKEN_RATES_BY_MODEL = Object.freeze({
  "codex-mini-latest": { input: 1.50, cachedInput: 0.375, output: 6.00 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10.00 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14.00 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14.00 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14.00 },
  "gpt-5.4": { input: 2.50, cachedInput: 0.25, output: 15.00 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.50 },
  "gpt-5.4-nano": { input: 0.20, cachedInput: 0.02, output: 1.25 },
  "gpt-5.5": { input: 5.00, cachedInput: 0.50, output: 30.00 },
});

/**
 * @param {string} model
 * @returns {string}
 */
function stripProviderPrefix(model) {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

/**
 * @param {string} model
 * @returns {string}
 */
function normalizeCodexPricingModel(model) {
  const normalized = stripProviderPrefix(model.trim().toLowerCase());
  if (normalized.startsWith("gpt-5.4-mini-")) {
    return "gpt-5.4-mini";
  }
  if (normalized.startsWith("gpt-5.4-nano-")) {
    return "gpt-5.4-nano";
  }
  for (const baseModel of Object.keys(CODEX_TOKEN_RATES_BY_MODEL).sort((a, b) => b.length - a.length)) {
    if (normalized === baseModel || normalized.startsWith(`${baseModel}-20`)) {
      return baseModel;
    }
  }
  return normalized;
}

/**
 * @param {string | null | undefined} model
 * @returns {CodexTokenRates | null}
 */
export function getCodexTokenRates(model) {
  if (!model) {
    return null;
  }
  return CODEX_TOKEN_RATES_BY_MODEL[normalizeCodexPricingModel(model)] ?? null;
}

/**
 * Estimate the USD cost of a Codex run from token usage.
 * Cached input tokens are included in the prompt token count, so uncached input
 * is `promptTokens - cachedTokens`.
 * @param {string | null | undefined} model
 * @param {HarnessUsage} usage
 * @returns {number | null}
 */
export function estimateCodexUsageCost(model, usage) {
  const rates = getCodexTokenRates(model);
  if (!rates) {
    return null;
  }
  const cachedInputTokens = Math.max(0, Math.min(usage.cachedTokens, usage.promptTokens));
  const uncachedInputTokens = Math.max(0, usage.promptTokens - cachedInputTokens);
  return (
    (uncachedInputTokens * rates.input)
    + (cachedInputTokens * rates.cachedInput)
    + (usage.completionTokens * rates.output)
  ) / TOKENS_PER_MILLION;
}
