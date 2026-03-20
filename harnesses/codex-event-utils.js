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
  for (const key of ["text", "message", "output", "stdout", "stderr", "content", "summary", "details", "error"]) {
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
