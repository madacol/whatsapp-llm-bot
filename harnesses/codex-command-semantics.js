/**
 * Parse Codex shell commands into higher-level file semantics so the rest of
 * the app does not need to understand raw shell syntax.
 */

/**
 * @typedef {{
 *   path: string,
 *   kind: "add" | "delete" | "update",
 *   diff?: string,
 * }} CodexPatchHint
 */

/**
 * @typedef {{
 *   readPaths: string[],
 *   snapshotPaths: string[],
 *   patches: CodexPatchHint[],
 * }} CodexCommandSemantics
 */

/**
 * @param {string} command
 * @returns {CodexCommandSemantics}
 */
export function analyzeCodexCommand(command) {
  const readPaths = extractReadPaths(command);
  const patches = extractApplyPatchHints(command);
  const snapshotPaths = [...new Set([...readPaths, ...patches.map((patch) => patch.path)])];
  return { readPaths, snapshotPaths, patches };
}

/**
 * @param {string} command
 * @returns {string[]}
 */
function extractReadPaths(command) {
  const argv = splitShellArgs(command);
  if (argv.length < 2) {
    return [];
  }

  const tool = argv[0];
  if (!tool) {
    return [];
  }

  if (tool === "cat" || tool === "head" || tool === "tail" || tool === "nl") {
    return argv.filter((arg, index) => index > 0 && !arg.startsWith("-"));
  }

  if (tool === "sed") {
    const positional = argv.filter((arg, index) => index > 0 && !arg.startsWith("-"));
    return positional.length > 1 ? [positional[positional.length - 1]] : positional;
  }

  return [];
}

/**
 * @param {string} command
 * @returns {CodexPatchHint[]}
 */
function extractApplyPatchHints(command) {
  const patchBody = extractApplyPatchBody(command);
  if (!patchBody) {
    return [];
  }

  const lines = patchBody.split("\n");
  /** @type {CodexPatchHint[]} */
  const hints = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }

    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    if (addMatch) {
      const path = addMatch[1];
      /** @type {string[]} */
      const addedLines = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const current = lines[index] ?? "";
        if (current.startsWith("+")) {
          addedLines.push(current);
        }
        index += 1;
      }
      hints.push({
        path,
        kind: "add",
        diff: [
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${addedLines.length} @@`,
          ...addedLines,
        ].join("\n"),
      });
      continue;
    }

    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    if (updateMatch) {
      const path = updateMatch[1];
      /** @type {string[]} */
      const hunkLines = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const current = lines[index] ?? "";
        if (current.startsWith("@@") || current.startsWith("+") || current.startsWith("-") || current.startsWith(" ")) {
          hunkLines.push(current);
        }
        index += 1;
      }
      hints.push({
        path,
        kind: "update",
        ...(hunkLines.length > 0
          ? { diff: [`--- a/${path}`, `+++ b/${path}`, ...hunkLines].join("\n") }
          : {}),
      });
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
    if (deleteMatch) {
      hints.push({
        path: deleteMatch[1],
        kind: "delete",
      });
      index += 1;
      continue;
    }

    index += 1;
  }

  return hints;
}

/**
 * @param {string} command
 * @returns {string | null}
 */
function extractApplyPatchBody(command) {
  const hereDocMatch = command.match(/^apply_patch\s+<<['"]?([A-Z_]+)['"]?\n([\s\S]*?)\n\1\s*$/);
  if (hereDocMatch) {
    return hereDocMatch[2] ?? null;
  }
  return null;
}

/**
 * Minimal shell splitting for the file-read commands Codex tends to emit.
 * @param {string} command
 * @returns {string[]}
 */
function splitShellArgs(command) {
  /** @type {string[]} */
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}
