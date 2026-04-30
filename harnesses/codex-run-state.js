import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { createLogger } from "../logger.js";
import { analyzeCodexCommand } from "./codex-command-semantics.js";

const log = createLogger("harness:codex-run-state");
const WORKSPACE_BASELINE_MAX_BYTES = 256 * 1024;
const WORKSPACE_BASELINE_SKIPPED_DIRS = new Set([".git", "node_modules"]);

/**
 * @typedef {{
 *   command?: { command: string, status: "started" | "completed" | "failed", output?: string },
 *   fileRead?: { command: string, paths: string[] },
 * }} CodexCommandDispatch
 */

/**
 * @typedef {{
 *   handleCommandEvent: (event: { command: string, status: "started" | "completed" | "failed", output?: string }) => Promise<CodexCommandDispatch>,
 *   enrichFileChangeEvent: (event: {
 *     path: string,
 *     summary?: string,
 *     diff?: string,
 *     kind?: "add" | "delete" | "update",
 *   }) => Promise<{
 *     path: string,
 *     summary?: string,
 *     diff?: string,
 *     kind?: "add" | "delete" | "update",
 *     oldText?: string,
 *     newText?: string,
 *   }>,
 * }} CodexRunState
 */

/**
 * Create the transient run-state used to correlate Codex commands with later
 * file-change events.
 * @param {{
 *   workdir?: string | null,
 *   loadWorkspaceBaseline?: (workdir: string) => Promise<Map<string, string>>,
 * }} input
 * @returns {CodexRunState}
 */
export function createCodexRunState({ workdir, loadWorkspaceBaseline = loadWorkspaceBaselineSnapshot }) {
  const resolvedWorkdir = typeof workdir === "string" && workdir.length > 0
    ? path.resolve(workdir)
    : null;
  /** @type {Map<string, string | null>} */
  const fileSnapshots = new Map();
  /** @type {Map<string, { diff?: string, kind?: "add" | "delete" | "update" }>} */
  const pendingFileDiffs = new Map();
  const workspaceBaselinePromise = resolvedWorkdir
    ? loadWorkspaceBaseline(resolvedWorkdir).catch(() => new Map())
    : null;

  return {
    handleCommandEvent,
    enrichFileChangeEvent,
  };

  /**
   * @param {{ command: string, status: "started" | "completed" | "failed", output?: string }} event
   * @returns {Promise<CodexCommandDispatch>}
   */
  async function handleCommandEvent(event) {
    const semantics = analyzeCodexCommand(event.command);
    if (event.status === "started") {
      await snapshotCommandPaths(semantics.snapshotPaths);
      for (const patch of semantics.patches) {
        pendingFileDiffs.set(resolveCommandPath(patch.path), {
          ...(patch.diff ? { diff: patch.diff } : {}),
          kind: patch.kind,
        });
      }
      if (semantics.readPaths.length > 0) {
        return {
          fileRead: {
            command: event.command,
            paths: semantics.readPaths,
          },
        };
      }
    }
    return { command: event };
  }

  /**
   * @param {{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" }} fileChange
   * @returns {Promise<{
   *   path: string,
   *   summary?: string,
   *   diff?: string,
   *   kind?: "add" | "delete" | "update",
   *   oldText?: string,
   *   newText?: string,
   * }>}
   */
  async function enrichFileChangeEvent(fileChange) {
    const absolutePath = resolveCommandPath(fileChange.path);
    const pending = pendingFileDiffs.get(absolutePath);
    if (pending) {
      pendingFileDiffs.delete(absolutePath);
    }

    let previousText = fileSnapshots.has(absolutePath)
      ? fileSnapshots.get(absolutePath) ?? null
      : null;
    const nextText = await readOptionalText(absolutePath);
    let usedWorkspaceBaseline = false;
    if (previousText == null && shouldUseWorkspaceBaseline(fileChange, pending)) {
      const baselineText = await readWorkspaceBaselineText(absolutePath);
      if (baselineText != null) {
        previousText = baselineText;
        usedWorkspaceBaseline = true;
      }
    }
    fileSnapshots.set(absolutePath, nextText);

    const eventDiff = isParseableDiff(fileChange.diff) ? fileChange.diff : undefined;
    const pendingDiff = isParseableDiff(pending?.diff) ? pending?.diff : undefined;
    const diff = eventDiff
      ?? pendingDiff
      ?? buildFileDiff(fileChange.path, previousText, nextText);
    const diffContent = diff ? extractUnifiedDiffContent(diff) : null;
    const oldText = previousText ?? diffContent?.oldText;
    const newText = previousText !== nextText
      ? nextText
      : diffContent?.newText ?? nextText;
    const reportedKind = fileChange.kind ?? pending?.kind;
    const kind = resolveFileChangeKind(reportedKind, oldText ?? null, newText ?? null);
    const summary = normalizeFileChangeSummary(fileChange.summary, fileChange.path, reportedKind, kind);
    const diffSource = eventDiff
      ? "event"
      : pendingDiff
        ? "apply_patch"
        : usedWorkspaceBaseline && diff
          ? "workspace_baseline"
        : diff
          ? "filesystem"
          : "none";

    const enriched = {
      ...fileChange,
      ...(summary !== undefined ? { summary } : {}),
      ...(kind ? { kind } : {}),
      ...(oldText != null ? { oldText } : {}),
      ...(newText != null ? { newText } : {}),
      ...(diff ? { diff } : {}),
    };
    log.debug("Enriched Codex file change", {
      diffSource,
      input: fileChange,
      pending,
      previousText,
      nextText,
      usedWorkspaceBaseline,
      output: enriched,
    });
    return enriched;
  }

  /**
   * @param {string[]} paths
   * @returns {Promise<void>}
   */
  async function snapshotCommandPaths(paths) {
    for (const relativePath of paths) {
      const absolutePath = resolveCommandPath(relativePath);
      if (fileSnapshots.has(absolutePath)) {
        continue;
      }
      fileSnapshots.set(absolutePath, await readOptionalText(absolutePath));
    }
  }

  /**
   * @param {string} relativePath
   * @returns {string}
   */
  function resolveCommandPath(relativePath) {
    if (path.isAbsolute(relativePath) || !resolvedWorkdir) {
      return relativePath;
    }
    return path.resolve(resolvedWorkdir, relativePath);
  }

  /**
   * @param {string} absolutePath
   * @returns {Promise<string | null>}
   */
  async function readWorkspaceBaselineText(absolutePath) {
    if (!workspaceBaselinePromise) {
      return null;
    }
    const baseline = await workspaceBaselinePromise;
    return baseline.get(absolutePath) ?? null;
  }
}

/**
 * Codex App Server can emit file changes as hunk-only diffs without file
 * headers. Those still carry enough old/new text to classify updates.
 * @param {string | undefined} diffText
 * @returns {diffText is string}
 */
function isParseableDiff(diffText) {
  if (!diffText) {
    return false;
  }
  return diffText.split("\n").some((line) => line.startsWith("@@"));
}

/**
 * @param {{ kind?: "add" | "delete" | "update", diff?: string }} fileChange
 * @param {{ diff?: string, kind?: "add" | "delete" | "update" } | undefined} pending
 * @returns {boolean}
 */
function shouldUseWorkspaceBaseline(fileChange, pending) {
  if (isParseableDiff(fileChange.diff) || isParseableDiff(pending?.diff)) {
    return false;
  }
  return true;
}

/**
 * Capture a text snapshot of the workspace at run start so later bare
 * `file_change` events from the SDK can still be diffed, especially deletes.
 * @param {string} workdir
 * @returns {Promise<Map<string, string>>}
 */
async function loadWorkspaceBaselineSnapshot(workdir) {
  /** @type {Map<string, string>} */
  const snapshot = new Map();
  await walk(workdir);
  return snapshot;

  /**
   * @param {string} dirPath
   * @returns {Promise<void>}
   */
  async function walk(dirPath) {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!WORKSPACE_BASELINE_SKIPPED_DIRS.has(entry.name)) {
          await walk(entryPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const text = await readOptionalText(entryPath, { maxBytes: WORKSPACE_BASELINE_MAX_BYTES });
      if (text != null) {
        snapshot.set(entryPath, text);
      }
    }
  }
}

/**
 * @param {string} filePath
 * @param {string | null} oldText
 * @param {string | null} newText
 * @returns {string | undefined}
 */
function buildFileDiff(filePath, oldText, newText) {
  if (oldText === newText) {
    return undefined;
  }
  if (oldText == null && newText == null) {
    return undefined;
  }
  const patchText = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, oldText ?? "", newText ?? "", "", "", {
    context: 3,
  });
  const lines = patchText.split("\n");
  const diffStart = lines.findIndex((line) => line.startsWith("--- "));
  const relevantLines = diffStart >= 0 ? lines.slice(diffStart) : lines;
  const normalizedLines = relevantLines.map((line) => (
    line.startsWith("--- ") || line.startsWith("+++ ")
      ? line.replace(/\t.*$/, "")
      : line
  ));
  return normalizedLines.join("\n").trim() || undefined;
}

/**
 * @param {string | null} oldText
 * @param {string | null} newText
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferFileChangeKind(oldText, newText) {
  if (oldText == null && newText != null) {
    return "add";
  }
  if (oldText != null && newText == null) {
    return "delete";
  }
  if (oldText != null && newText != null && oldText !== newText) {
    return "update";
  }
  return undefined;
}

/**
 * Keep the reported kind authoritative unless it conflicts with observed
 * before/after content in a way that would misclassify overwrites as adds.
 * @param {"add" | "delete" | "update" | undefined} reportedKind
 * @param {string | null} oldText
 * @param {string | null} newText
 * @returns {"add" | "delete" | "update" | undefined}
 */
function resolveFileChangeKind(reportedKind, oldText, newText) {
  const inferredKind = inferFileChangeKind(oldText, newText);

  if (reportedKind === "add" && oldText != null && oldText.length > 0) {
    return inferredKind ?? reportedKind;
  }
  if (reportedKind === "update" && inferredKind === "add") {
    return "add";
  }
  return reportedKind ?? inferredKind;
}

/**
 * Rewrite the default "{path} ({kind})" summary when normalization changes the
 * kind, while preserving any non-default human-authored summary text.
 * @param {string | undefined} summary
 * @param {string} path
 * @param {"add" | "delete" | "update" | undefined} reportedKind
 * @param {"add" | "delete" | "update" | undefined} resolvedKind
 * @returns {string | undefined}
 */
function normalizeFileChangeSummary(summary, path, reportedKind, resolvedKind) {
  if (!summary || !reportedKind || !resolvedKind || reportedKind === resolvedKind) {
    return summary;
  }

  const defaultSummary = `${path} (${reportedKind})`;
  if (summary === defaultSummary) {
    return `${path} (${resolvedKind})`;
  }

  return summary;
}

/**
 * Extract approximate before/after text from a unified diff.
 * This is a fallback when the filesystem does not reflect the change yet.
 * @param {string} diffText
 * @returns {{ oldText?: string, newText?: string } | null}
 */
function extractUnifiedDiffContent(diffText) {
  if (!isParseableDiff(diffText)) {
    return null;
  }

  /** @type {string[]} */
  const oldLines = [];
  /** @type {string[]} */
  const newLines = [];

  for (const line of diffText.split("\n")) {
    if (
      line.startsWith("--- ")
      || line.startsWith("+++ ")
      || line.startsWith("@@ ")
      || line === "\\ No newline at end of file"
    ) {
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    }
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    return null;
  }

  return {
    ...(oldLines.length > 0 ? { oldText: oldLines.join("\n") + "\n" } : {}),
    ...(newLines.length > 0 ? { newText: newLines.join("\n") + "\n" } : {}),
  };
}

/**
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<string | null>}
 */
async function readOptionalText(filePath, options = {}) {
  try {
    const content = await fs.readFile(filePath);
    if (typeof options.maxBytes === "number" && content.byteLength > options.maxBytes) {
      return null;
    }
    if (content.includes(0)) {
      return null;
    }
    return content.toString("utf8");
  } catch {
    return null;
  }
}
