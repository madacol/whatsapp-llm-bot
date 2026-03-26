import { createLogger } from "../logger.js";
import { extractCodexText, isCodexEventRecord } from "./codex-event-utils.js";

const log = createLogger("harness:codex-file-events");

/**
 * Normalize file-change payloads from Codex item events.
 * @param {unknown} item
 * @returns {{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" } | null}
 */
export function normalizeCodexFileChange(item) {
  const path = extractFilePath(item);
  if (!path) {
    return null;
  }

  const diff = extractFileDiff(item);
  const kind = extractFileKind(item);
  const normalized = {
    path,
    summary: extractFileSummary(item),
    ...(kind ? { kind } : {}),
    ...(diff ? { diff } : {}),
  };
  log.debug("Normalized Codex file change payload", {
    input: item,
    output: normalized,
  });
  return normalized;
}

/**
 * Extract a file path from a Codex event item when present.
 * @param {unknown} item
 * @returns {string | null}
 */
function extractFilePath(item) {
  if (!isCodexEventRecord(item)) {
    return null;
  }
  if (Array.isArray(item.changes)) {
    const firstChange = item.changes.find(isCodexEventRecord);
    if (firstChange && typeof firstChange.path === "string" && firstChange.path.length > 0) {
      return firstChange.path;
    }
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
function extractFileDiff(item) {
  if (!isCodexEventRecord(item)) {
    return undefined;
  }

  for (const key of ["patch", "diff", "unified_diff"]) {
    const diffText = extractCodexText(item[key]);
    if (diffText) {
      return diffText;
    }
  }

  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (!isCodexEventRecord(change)) {
        continue;
      }
      for (const key of ["patch", "diff", "unified_diff"]) {
        const diffText = extractCodexText(change[key]);
        if (diffText) {
          return diffText;
        }
      }
    }
  }

  return undefined;
}

/**
 * @param {unknown} item
 * @returns {"add" | "delete" | "update" | undefined}
 */
function extractFileKind(item) {
  if (!isCodexEventRecord(item)) {
    return undefined;
  }
  if (Array.isArray(item.changes)) {
    const firstChange = item.changes.find(isCodexEventRecord);
    if (firstChange && (firstChange.kind === "add" || firstChange.kind === "delete" || firstChange.kind === "update")) {
      return firstChange.kind;
    }
  }
  return undefined;
}
