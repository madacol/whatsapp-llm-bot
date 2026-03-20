import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { analyzeCodexCommand } from "./codex-command-semantics.js";

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
 * @param {{ workdir?: string | null }} input
 * @returns {CodexRunState}
 */
export function createCodexRunState({ workdir }) {
  /** @type {Map<string, string | null>} */
  const fileSnapshots = new Map();
  /** @type {Map<string, { diff?: string, kind?: "add" | "delete" | "update" }>} */
  const pendingFileDiffs = new Map();

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

    const previousText = fileSnapshots.has(absolutePath)
      ? fileSnapshots.get(absolutePath) ?? null
      : null;
    const nextText = await readOptionalText(absolutePath);
    fileSnapshots.set(absolutePath, nextText);

    const diff = fileChange.diff
      ?? pending?.diff
      ?? buildFileDiff(fileChange.path, previousText, nextText);
    const diffContent = diff ? extractUnifiedDiffContent(diff) : null;
    const kind = fileChange.kind ?? pending?.kind ?? inferFileChangeKind(previousText, nextText);
    const oldText = previousText ?? diffContent?.oldText;
    const newText = previousText !== nextText
      ? nextText
      : diffContent?.newText ?? nextText;

    return {
      ...fileChange,
      ...(kind ? { kind } : {}),
      ...(oldText != null ? { oldText } : {}),
      ...(newText != null ? { newText } : {}),
      ...(diff ? { diff } : {}),
    };
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
    if (path.isAbsolute(relativePath) || !workdir) {
      return relativePath;
    }
    return path.resolve(workdir, relativePath);
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
  return lines.slice(2).join("\n").trim() || undefined;
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
 * Extract approximate before/after text from a unified diff.
 * This is a fallback when the filesystem does not reflect the change yet.
 * @param {string} diffText
 * @returns {{ oldText?: string, newText?: string } | null}
 */
function extractUnifiedDiffContent(diffText) {
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
 * @returns {Promise<string | null>}
 */
async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
