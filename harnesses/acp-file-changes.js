import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUnifiedFileDiff } from "./file-change-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_IGNORE_FILE_PATH = path.join(REPO_ROOT, "snapshot-ignore.txt");
const DEFAULT_SNAPSHOT_IGNORE_PATTERNS = loadSnapshotIgnorePatterns();

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
  const ignoredPaths = loadSnapshotIgnorePatternsForWorkdir(root);
  await collectSnapshotFiles(root, root, snapshot, ignoredPaths);
  return snapshot;
}

/**
 * @param {string | null | undefined} workdir
 * @param {string[]} filePaths
 * @returns {Promise<Map<string, string>>}
 */
export async function snapshotAcpPaths(workdir, filePaths) {
  /** @type {Map<string, string>} */
  const snapshot = new Map();
  const resolvedPaths = [...new Set(filePaths.map((filePath) => resolveAcpFileChangePath(workdir, filePath)))];
  for (const filePath of resolvedPaths) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      if (!content.includes("\0")) {
        snapshot.set(filePath, content);
      }
    } catch {
      // Targeted snapshots are best-effort; missing files are represented by absence.
    }
  }
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
 * @typedef {{
 *   negated: boolean;
 *   directoryOnly: boolean;
 *   exactRegExp: RegExp;
 *   descendantRegExp: RegExp;
 * }} SnapshotIgnorePattern
 */

/**
 * @param {string} pattern
 * @returns {SnapshotIgnorePattern | null}
 */
function parseSnapshotIgnorePattern(pattern) {
  let normalized = normalizeSlashes(pattern.trim());
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("\\#") || normalized.startsWith("\\!")) {
    normalized = normalized.slice(1);
  }
  const negated = normalized.startsWith("!");
  if (negated) {
    normalized = normalized.slice(1).trim();
  }
  if (!normalized) {
    return null;
  }
  const directoryOnly = normalized.endsWith("/");
  normalized = normalized.replace(/\/+$/, "");
  const anchored = normalized.startsWith("/") || normalized.includes("/");
  normalized = normalized.replace(/^\/+/, "");
  if (!normalized) {
    return null;
  }

  const leadingAnyDirectory = normalized.startsWith("**/");
  if (leadingAnyDirectory) {
    normalized = normalized.slice(3);
  }
  const prefix = leadingAnyDirectory || !anchored ? "(?:^|.*/)" : "^";
  const source = prefix + gitignoreGlobSource(normalized);
  return {
    negated,
    directoryOnly,
    exactRegExp: new RegExp(`${source}$`),
    descendantRegExp: new RegExp(`${source}/.*$`),
  };
}

/**
 * @param {string} pattern
 * @returns {string}
 */
function gitignoreGlobSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (pattern.startsWith("/**", index) && index + 3 === pattern.length) {
      source += "/.*";
      index += 2;
      continue;
    }
    const char = pattern[index];
    const next = pattern[index + 1];
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
  return source;
}

/**
 * @param {SnapshotIgnorePattern} pattern
 * @param {string} normalizedRelativePath
 * @param {boolean} isDirectory
 * @returns {boolean}
 */
function snapshotIgnorePatternMatches(pattern, normalizedRelativePath, isDirectory) {
  if (pattern.directoryOnly) {
    return pattern.descendantRegExp.test(normalizedRelativePath)
      || (isDirectory && pattern.exactRegExp.test(normalizedRelativePath));
  }
  return pattern.exactRegExp.test(normalizedRelativePath)
    || pattern.descendantRegExp.test(normalizedRelativePath);
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
 * @returns {string[]}
 */
function loadSnapshotIgnorePatterns() {
  return loadSnapshotIgnorePatternsFromFile(SNAPSHOT_IGNORE_FILE_PATH);
}

/**
 * @param {string} filePath
 * @returns {string[]}
 */
function loadSnapshotIgnorePatternsFromFile(filePath) {
  let rawPatterns;
  try {
    rawPatterns = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return rawPatterns
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * @param {string} workdir
 * @returns {string[]}
 */
function loadSnapshotIgnorePatternsForWorkdir(workdir) {
  const workspaceIgnorePath = path.join(workdir, "snapshot-ignore.txt");
  const workspacePatterns = path.resolve(workspaceIgnorePath) === path.resolve(SNAPSHOT_IGNORE_FILE_PATH)
    ? []
    : loadSnapshotIgnorePatternsFromFile(workspaceIgnorePath);
  return [
    ...DEFAULT_SNAPSHOT_IGNORE_PATTERNS,
    ...workspacePatterns,
  ];
}

/**
 * @param {string} root
 * @param {string} filePath
 * @param {string[]} patterns
 * @param {boolean} [isDirectory]
 * @returns {boolean}
 */
function isPathIgnoredByPatterns(root, filePath, patterns, isDirectory = false) {
  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }
  const normalizedRelativePath = normalizeSlashes(relativePath);
  let ignored = false;
  for (const rawPattern of patterns) {
    const pattern = parseSnapshotIgnorePattern(rawPattern);
    if (!pattern || !snapshotIgnorePatternMatches(pattern, normalizedRelativePath, isDirectory)) {
      continue;
    }
    ignored = !pattern.negated;
  }
  return ignored;
}

/**
 * @param {string[]} patterns
 * @returns {boolean}
 */
function hasNegatedPattern(patterns) {
  return patterns.some((pattern) => {
    const normalized = normalizeSlashes(pattern.trim());
    return normalized.startsWith("!") && normalized.length > 1;
  });
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {string} filePath
 * @returns {boolean}
 */
export function isAcpFileChangeIgnored(runConfig, filePath) {
  const root = path.resolve(runConfig?.workdir ?? process.cwd());
  const patterns = normalizePatternList(runConfig?.ignoredFileChangePaths);
  if (patterns.length === 0) {
    return false;
  }
  const resolvedPath = resolveAcpFileChangePath(root, filePath);
  const relativePath = path.relative(root, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }
  return isPathIgnoredByPatterns(root, resolvedPath, patterns);
}

/**
 * @param {import("./harness-runtime-events.js").HarnessRuntimeEventInput} event
 * @param {Map<string, string> | null} baseline
 * @param {string | null | undefined} workdir
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput}
 */
export function reconcileAcpFileChangeWithBaseline(event, baseline, workdir) {
  if (event.type !== "file-change.completed" || !baseline) {
    return event;
  }
  if (event.change.source === "snapshot") {
    return event;
  }
  const resolvedPath = resolveAcpFileChangePath(workdir, event.change.path);
  const baselineText = baseline.get(resolvedPath);
  if (baselineText === undefined) {
    return event;
  }
  const missingOldText = event.change.oldText === undefined;
  const mislabeledAdd = event.change.kind === "add";
  const oldText = missingOldText ? baselineText : event.change.oldText;
  const missingAfterEmptyTextEdit = event.change.kind === "update"
    && event.change.newText === ""
    && !existsSync(resolvedPath);
  const correctedKind = event.change.kind === "delete" || missingAfterEmptyTextEdit ? "delete" : "update";
  const newText = correctedKind === "delete" ? undefined : event.change.newText;
  const needsDiff = event.change.diff === undefined
    && (correctedKind === "delete" || typeof newText === "string");
  if (!missingOldText && !mislabeledAdd && !missingAfterEmptyTextEdit && !needsDiff) {
    return event;
  }

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
      newText,
      ...(diff ? { diff } : {}),
    },
  };
}

/**
 * @param {Map<string, string> | null} baseline
 * @param {import("./harness-runtime-events.js").HarnessRuntimeEventInput} event
 * @param {string | null | undefined} workdir
 * @returns {void}
 */
export function updateAcpFileChangeBaseline(baseline, event, workdir) {
  if (!baseline || event.type !== "file-change.completed") {
    return;
  }
  const resolvedPath = resolveAcpFileChangePath(workdir, event.change.path);
  if (event.change.kind === "delete") {
    baseline.delete(resolvedPath);
    return;
  }
  if (typeof event.change.newText === "string") {
    baseline.set(resolvedPath, event.change.newText);
  }
}

/**
 * @param {{
 *   before: Map<string, string> | null,
 *   after: Map<string, string> | null,
 *   emittedPaths: Set<string>,
 * }} input
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]}
 */
export function collectAcpSnapshotFileChanges(input) {
  if (!input.before || !input.after) {
    return [];
  }
  /** @type {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]} */
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
      diagnosticRaw: { source: "workdir-snapshot" },
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
      diagnosticRaw: { source: "workdir-snapshot" },
    });
  }
  return events;
}

/**
 * @param {{
 *   before: Map<string, string>,
 *   after: Map<string, string>,
 *   emittedPaths: Set<string>,
 *   summary: string,
 *   diagnosticRaw: Record<string, unknown>,
 * }} input
 * @returns {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]}
 */
export function collectAcpTargetedFileChanges(input) {
  /** @type {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]} */
  const events = [];
  for (const [filePath, newText] of input.after) {
    if (input.emittedPaths.has(filePath)) {
      continue;
    }
    const oldText = input.before.get(filePath);
    if (oldText === newText) {
      continue;
    }
    const kind = oldText === undefined ? "add" : "update";
    const diff = buildUnifiedFileDiff(filePath, oldText, newText);
    events.push({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: input.summary,
        kind,
        source: "tool",
        ...(oldText !== undefined ? { oldText } : {}),
        newText,
        ...(diff ? { diff } : {}),
      },
      diagnosticRaw: input.diagnosticRaw,
    });
  }
  for (const [filePath, oldText] of input.before) {
    if (input.emittedPaths.has(filePath) || input.after.has(filePath)) {
      continue;
    }
    const diff = buildUnifiedFileDiff(filePath, oldText, undefined);
    events.push({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: input.summary,
        kind: "delete",
        source: "tool",
        oldText,
        ...(diff ? { diff } : {}),
      },
      diagnosticRaw: input.diagnosticRaw,
    });
  }
  return events;
}

/**
 * @param {import("./harness-runtime-events.js").HarnessRuntimeEventInput[]} events
 * @param {(event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>} emitRuntimeEvent
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
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>,
 * }} input
 * @returns {Promise<void>}
 */
export async function emitAcpSnapshotFileChanges(input) {
  const events = collectAcpSnapshotFileChanges(input);
  await emitAcpSnapshotFileChangeEvents(events, input.emitRuntimeEvent);
}

/**
 * @param {string} root
 * @param {string} currentPath
 * @param {Map<string, string>} snapshot
 * @param {string[]} ignoredPaths
 * @returns {Promise<void>}
 */
async function collectSnapshotFiles(root, currentPath, snapshot, ignoredPaths) {
  const keepIgnoredDirectoriesTraversable = hasNegatedPattern(ignoredPaths);
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(currentPath, entry.name);
    if (
      isPathIgnoredByPatterns(root, filePath, ignoredPaths, entry.isDirectory())
      && !(entry.isDirectory() && keepIgnoredDirectoriesTraversable)
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectSnapshotFiles(root, filePath, snapshot, ignoredPaths);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
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
