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
 * Normalize Codex usage counters from SDK or app-server payloads.
 * `fallback` lets callers preserve support for older flat top-level fields.
 * @param {unknown} value
 * @param {unknown} [fallback]
 * @returns {HarnessUsage}
 */
export function normalizeCodexUsage(value, fallback) {
  const usage = resolveCodexUsageRecord(value);
  const fallbackRecord = isCodexEventRecord(fallback) ? fallback : null;

  const promptTokens = typeof usage?.input_tokens === "number"
    ? usage.input_tokens
    : typeof usage?.inputTokens === "number"
      ? usage.inputTokens
      : typeof fallbackRecord?.input_tokens === "number"
        ? fallbackRecord.input_tokens
        : typeof fallbackRecord?.inputTokens === "number" ? fallbackRecord.inputTokens : 0;

  const completionTokens = typeof usage?.output_tokens === "number"
    ? usage.output_tokens
    : typeof usage?.outputTokens === "number"
      ? usage.outputTokens
      : typeof fallbackRecord?.output_tokens === "number"
        ? fallbackRecord.output_tokens
        : typeof fallbackRecord?.outputTokens === "number" ? fallbackRecord.outputTokens : 0;

  const cachedTokens = typeof usage?.cached_input_tokens === "number"
    ? usage.cached_input_tokens
    : typeof usage?.cachedInputTokens === "number"
      ? usage.cachedInputTokens
      : typeof fallbackRecord?.cached_input_tokens === "number"
        ? fallbackRecord.cached_input_tokens
        : typeof fallbackRecord?.cachedInputTokens === "number" ? fallbackRecord.cachedInputTokens : 0;

  const cost = typeof usage?.cost === "number"
    ? usage.cost
    : typeof fallbackRecord?.cost === "number" ? fallbackRecord.cost : 0;

  return {
    promptTokens,
    completionTokens,
    cachedTokens,
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
