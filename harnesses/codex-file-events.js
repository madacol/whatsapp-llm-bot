import { createLogger } from "../logger.js";
import { extractCodexText, isCodexEventRecord } from "./codex-event-utils.js";

const log = createLogger("harness:codex-file-events");

/**
 * Normalize file-change payloads from Codex item events.
 * @param {unknown} item
 * @returns {{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" } | null}
 */
export function normalizeCodexFileChange(item) {
  return normalizeCodexFileChanges(item)[0] ?? null;
}

/**
 * Normalize file-change payloads from Codex item events into one entry per
 * changed file. The SDK can batch several paths into a single `file_change`.
 * @param {unknown} item
 * @returns {Array<{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" }>}
 */
export function normalizeCodexFileChanges(item) {
  const normalized = extractFileChanges(item);
  log.debug("Normalized Codex file change payload", {
    input: item,
    output: normalized.length === 1 ? normalized[0] : normalized,
  });
  return normalized;
}

/**
 * Extract file changes from a Codex event item when present.
 * @param {unknown} item
 * @returns {Array<{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" }>}
 */
function extractFileChanges(item) {
  if (!isCodexEventRecord(item)) {
    return [];
  }
  if (Array.isArray(item.changes)) {
    const topLevelDiff = item.changes.length === 1
      ? extractTopLevelChangeDiff(item)
      : undefined;
    const normalizedChanges = item.changes
      .filter(isCodexEventRecord)
      .map((change) => {
        const path = typeof change.path === "string" && change.path.length > 0
          ? change.path
          : null;
        if (!path) {
          return null;
        }
        const kind = extractChangeKind(change);
        const diff = extractTopLevelChangeDiff(change) ?? topLevelDiff;
        return {
          path,
          summary: kind ? `${path} (${kind})` : path,
          ...(kind ? { kind } : {}),
          ...(diff ? { diff } : {}),
        };
      })
      .filter((change) => change != null);
    if (normalizedChanges.length > 0) {
      return normalizedChanges;
    }
  }

  const path = extractStandaloneFilePath(item);
  if (!path) {
    return [];
  }

  const diff = extractTopLevelChangeDiff(item);
  const kind = extractChangeKind(item);
  return [{
    path,
    summary: extractFileSummary(item),
    ...(kind ? { kind } : {}),
    ...(diff ? { diff } : {}),
  }];
}

/**
 * Extract a file path from a non-batched Codex event item when present.
 * @param {unknown} item
 * @returns {string | null}
 */
function extractStandaloneFilePath(item) {
  if (!isCodexEventRecord(item)) {
    return null;
  }
  for (const key of ["path", "file_path", "file"]) {
    if (typeof item[key] === "string" && item[key].length > 0) {
      return item[key];
    }
  }
  return null;
}

/**
 * @param {unknown} item
 * @returns {string | undefined}
 */
function extractFileSummary(item) {
  if (!isCodexEventRecord(item)) {
    return undefined;
  }
  if (Array.isArray(item.changes)) {
    const parts = item.changes
      .filter(isCodexEventRecord)
      .map((change) => {
        if (typeof change.path === "string" && typeof change.kind === "string") {
          return `${change.path} (${change.kind})`;
        }
        if (typeof change.path === "string") {
          return change.path;
        }
        return null;
      })
      .filter((part) => typeof part === "string" && part.length > 0);
    if (parts.length > 0) {
      return parts.join(", ");
    }
  }
  return extractCodexText(item) ?? undefined;
}

/**
 * @param {unknown} item
 * @returns {string | undefined}
 */
function extractTopLevelChangeDiff(item) {
  if (!isCodexEventRecord(item)) {
    return undefined;
  }

  for (const key of ["patch", "diff", "unified_diff"]) {
    const diffText = extractCodexText(item[key]);
    if (diffText && looksLikeDiff(diffText)) {
      return diffText;
    }
  }
  return undefined;
}

/**
 * Codex sometimes sends full file contents in `patch` for adds instead of a
 * unified diff. App Server fileChange events can also send hunk-only diffs
 * without file headers, so accept payloads with a hunk marker.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeDiff(text) {
  return text.split("\n").some((line) => line.startsWith("@@"));
}

/**
 * @param {unknown} item
 * @returns {"add" | "delete" | "update" | undefined}
 */
function extractChangeKind(item) {
  if (!isCodexEventRecord(item)) {
    return undefined;
  }
  if (item.kind === "add" || item.kind === "delete" || item.kind === "update") {
    return item.kind;
  }
  if (isCodexEventRecord(item.kind)) {
    const kindType = item.kind.type;
    if (kindType === "add" || kindType === "delete" || kindType === "update") {
      return kindType;
    }
  }
  return undefined;
}
