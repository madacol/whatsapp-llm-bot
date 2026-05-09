/**
 * Shared Codex event helpers used by multiple event normalizers.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isCodexEventRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the innermost Codex usage record from an event-like payload.
 * Supports SDK events (`usage`), app-server events (`tokenUsage.last` /
 * `tokenUsage.total`), and already-flat usage records.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function resolveCodexUsageRecord(value) {
  if (!isCodexEventRecord(value)) {
    return null;
  }

  if (isCodexEventRecord(value.usage)) {
    return resolveCodexUsageRecord(value.usage);
  }

  if (isCodexEventRecord(value.tokenUsage)) {
    return resolveCodexUsageRecord(value.tokenUsage);
  }

  if (isCodexEventRecord(value.last)) {
    return resolveCodexUsageRecord(value.last);
  }

  if (isCodexEventRecord(value.total)) {
    return resolveCodexUsageRecord(value.total);
  }

  return value;
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string[]} keys
 * @returns {number | undefined}
 */
function readNumberField(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function resolveCodexTokenUsageRecord(value) {
  if (!isCodexEventRecord(value)) {
    return null;
  }
  return isCodexEventRecord(value.tokenUsage) ? value.tokenUsage : value;
}

/**
 * Normalize Codex usage counters from SDK or app-server payloads.
 * `fallback` lets callers preserve support for older flat top-level fields.
 * @param {unknown} value
 * @param {unknown} [fallback]
 * @returns {HarnessUsage}
 */
export function normalizeCodexUsage(value, fallback) {
  const usage = resolveCodexUsageRecord(value);
  const tokenUsage = resolveCodexTokenUsageRecord(value);
  const fallbackRecord = isCodexEventRecord(fallback) ? fallback : null;

  const promptTokens = readNumberField(usage, ["input_tokens", "inputTokens"])
    ?? readNumberField(fallbackRecord, ["input_tokens", "inputTokens"])
    ?? 0;
  const completionTokens = readNumberField(usage, ["output_tokens", "outputTokens"])
    ?? readNumberField(fallbackRecord, ["output_tokens", "outputTokens"])
    ?? 0;
  const cachedTokens = readNumberField(usage, ["cached_input_tokens", "cachedInputTokens"])
    ?? readNumberField(fallbackRecord, ["cached_input_tokens", "cachedInputTokens"])
    ?? 0;

  const totalTokens = readNumberField(usage, ["total_tokens", "totalTokens"])
    ?? readNumberField(tokenUsage, ["total_tokens", "totalTokens"])
    ?? readNumberField(fallbackRecord, ["total_tokens", "totalTokens"]);
  const reasoningTokens = readNumberField(usage, ["reasoning_output_tokens", "reasoningOutputTokens"])
    ?? readNumberField(fallbackRecord, ["reasoning_output_tokens", "reasoningOutputTokens"]);
  const contextWindow = readNumberField(tokenUsage, ["model_context_window", "modelContextWindow"])
    ?? readNumberField(fallbackRecord, ["model_context_window", "modelContextWindow"]);
  const cost = readNumberField(usage, ["cost"]) ?? readNumberField(fallbackRecord, ["cost"]) ?? 0;

  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    ...(totalTokens !== undefined && { totalTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    ...(contextWindow !== undefined && { contextWindow }),
    cost,
  };
}

/**
 * Best-effort text extraction from Codex event payloads.
 * @param {unknown} value
 * @returns {string | null}
 */
export function extractCodexText(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = extractCodexText(parsed);
        if (nested) {
          return nested;
        }
      } catch {
        // Fall through to the raw string when the payload is not valid JSON.
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(extractCodexText).filter((part) => typeof part === "string" && part.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (!isCodexEventRecord(value)) {
    return null;
  }
  for (const key of ["text", "message", "output", "stdout", "stderr", "content", "summary", "details", "error", "resource", "status", "data"]) {
    const nested = extractCodexText(value[key]);
    if (nested) {
      return nested;
    }
  }

  if (Array.isArray(value.steps)) {
    const stepText = value.steps.map(extractCodexText).filter((part) => typeof part === "string" && part.length > 0);
    if (stepText.length > 0) {
      return stepText.join("\n");
    }
  }

  return null;
}

/**
 * Extract an ordered list of text fragments from Codex reasoning content.
 * Supports plain strings, arrays of strings, and object items that expose
 * a `text` field.
 * @param {unknown} value
 * @returns {string[]}
 */
export function extractCodexReasoningParts(value) {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractCodexReasoningParts(entry));
  }
  if (!isCodexEventRecord(value)) {
    return [];
  }
  if (typeof value.text === "string") {
    return value.text.length > 0 ? [value.text] : [];
  }
  return [];
}
