import fs from "node:fs/promises";
import path from "node:path";
import { isRuntimeStateSnapshotPath } from "../snapshot-file-policy.js";
import { buildUnifiedFileDiff } from "./file-change-utils.js";

const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_EXCLUDED_DIRS = new Set([".git", "node_modules", ".media", "coverage", "dist", "build"]);
const DEFAULT_IGNORED_FILE_CHANGE_PATHS = [
  ".agents/.runtime/**",
  ".diagnostics/**",
  ".madabot/**",
  ".media/**",
  ".state/**",
  ".wwebjs_auth/**",
  ".wwebjs_cache/**",
  "auth_info_baileys/**",
  "pgdata/**",
];

/**
 * @param {string | null | undefined} workdir
 * @returns {Promise<Map<string, string> | null>}
 */
export async function snapshotAcpWorkdir(workdir) {
  if (typeof workdir !== "string" || !workdir.trim()) {
    return null;
  }
  const root = path.resolve(workdir);
  /** @type {Map<string, string>} */
  const snapshot = new Map();
  await collectSnapshotFiles(root, snapshot);
  return snapshot;
}

/**
 * @param {string | null | undefined} workdir
 * @param {string} filePath
 * @returns {string}
 */
export function resolveAcpFileChangePath(workdir, filePath) {
  return path.resolve(workdir ?? process.cwd(), filePath);
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const normalized = normalizeSlashes(pattern.trim()).replace(/^\/+/, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizePatternList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : [];
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {string} filePath
 * @returns {boolean}
 */
export function isAcpFileChangeIgnored(runConfig, filePath) {
  if (isRuntimeStateSnapshotPath(filePath)) {
    return true;
  }
  const patterns = [
    ...DEFAULT_IGNORED_FILE_CHANGE_PATHS,
    ...normalizePatternList(runConfig?.ignoredFileChangePaths),
  ];
  if (patterns.length === 0) {
    return false;
  }
  const root = path.resolve(runConfig?.workdir ?? process.cwd());
  const resolvedPath = resolveAcpFileChangePath(root, filePath);
  const relativePath = path.relative(root, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }
  const normalizedRelativePath = normalizeSlashes(relativePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalizedRelativePath));
}

/**
 * @param {import("./harness-runtime-events.js").HarnessRuntimeEvent} event
 * @param {Map<string, string> | null} beforeSnapshot
 * @param {string | null | undefined} workdir
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeEvent}
 */
export function reconcileAcpFileChangeWithBaseline(event, beforeSnapshot, workdir) {
  if (event.type !== "file-change.completed" || !beforeSnapshot) {
    return event;
  }
  if (event.change.source === "snapshot") {
    return event;
  }
  const resolvedPath = resolveAcpFileChangePath(workdir, event.change.path);
  const baselineText = beforeSnapshot.get(resolvedPath);
  if (baselineText === undefined) {
    return event;
  }
  const missingOldText = event.change.oldText === undefined;
  const mislabeledAdd = event.change.kind === "add";
  const oldText = missingOldText ? baselineText : event.change.oldText;
  const newText = event.change.kind === "delete" ? undefined : event.change.newText;
  const needsDiff = event.change.diff === undefined
    && (event.change.kind === "delete" || typeof newText === "string");
  if (!missingOldText && !mislabeledAdd && !needsDiff) {
    return event;
  }

  const correctedKind = event.change.kind === "delete" ? "delete" : "update";
  const diff = event.change.diff ?? buildUnifiedFileDiff(
    resolvedPath,
    oldText,
    newText,
  );
  return {
    ...event,
    change: {
      ...event.change,
      kind: correctedKind,
      oldText,
      ...(diff ? { diff } : {}),
    },
  };
}

/**
 * @param {{
 *   before: Map<string, string> | null,
 *   after: Map<string, string> | null,
 *   emittedPaths: Set<string>,
 * }} input
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeFileChangeEvent[]}
 */
export function collectAcpSnapshotFileChanges(input) {
  if (!input.before || !input.after) {
    return [];
  }
  /** @type {import("./harness-runtime-events.js").HarnessRuntimeFileChangeEvent[]} */
  const events = [];
  for (const [filePath, newText] of input.after) {
    if (input.emittedPaths.has(filePath)) {
      continue;
    }
    const oldText = input.before.get(filePath);
    if (oldText === newText) {
      continue;
    }
    events.push({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: "ACP file change",
        kind: oldText === undefined ? "add" : "update",
        source: "snapshot",
        ...(oldText !== undefined ? { oldText } : {}),
        newText,
      },
      raw: { source: "workdir-snapshot" },
    });
  }
  for (const [filePath, oldText] of input.before) {
    if (input.emittedPaths.has(filePath) || input.after.has(filePath)) {
      continue;
    }
    events.push({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: "ACP file delete",
        kind: "delete",
        source: "snapshot",
        oldText,
      },
      raw: { source: "workdir-snapshot" },
    });
  }
  return events;
}

/**
 * @param {import("./harness-runtime-events.js").HarnessRuntimeFileChangeEvent[]} events
 * @param {(event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>} emitRuntimeEvent
 * @returns {Promise<void>}
 */
export async function emitAcpSnapshotFileChangeEvents(events, emitRuntimeEvent) {
  for (const event of events) {
    await emitRuntimeEvent(event);
  }
}

/**
 * @param {{
 *   before: Map<string, string> | null,
 *   after: Map<string, string> | null,
 *   emittedPaths: Set<string>,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 * }} input
 * @returns {Promise<void>}
 */
export async function emitAcpSnapshotFileChanges(input) {
  const events = collectAcpSnapshotFileChanges(input);
  await emitAcpSnapshotFileChangeEvents(events, input.emitRuntimeEvent);
}

/**
 * @param {string} currentPath
 * @param {Map<string, string>} snapshot
 * @returns {Promise<void>}
 */
async function collectSnapshotFiles(currentPath, snapshot) {
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) {
        await collectSnapshotFiles(path.join(currentPath, entry.name), snapshot);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(currentPath, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      if (!content.includes("\0")) {
        snapshot.set(filePath, content);
      }
    } catch {
      // Snapshotting is a best-effort display fallback.
    }
  }
}
