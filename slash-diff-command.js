import { execFile } from "node:child_process";
import { contentEvent } from "./outbound-events.js";

const GIT_DIFF_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * @typedef {{
 *   path: string;
 *   changeKind: "add" | "delete" | "update";
 *   diff: string;
 * }} ParsedGitDiffFile
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: GIT_DIFF_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(error);
      },
    );
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimTrailingNewline(value) {
  return value.replace(/\n+$/g, "");
}

/**
 * @param {string} rawPath
 * @returns {string}
 */
function stripDiffPathPrefix(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed === "/dev/null") {
    return "";
  }
  return trimmed.replace(/^[ab]\//, "");
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function parseUnifiedPathLine(line) {
  const match = /^(?:---|\+\+\+) ([^\t]+)(?:\t.*)?$/.exec(line);
  return match ? stripDiffPathPrefix(match[1] ?? "") : null;
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function parseDiffPath(lines) {
  const newPathLine = lines.find((line) => line.startsWith("+++ "));
  const oldPathLine = lines.find((line) => line.startsWith("--- "));
  const newPath = newPathLine ? parseUnifiedPathLine(newPathLine) : null;
  if (newPath) {
    return newPath;
  }
  const oldPath = oldPathLine ? parseUnifiedPathLine(oldPathLine) : null;
  if (oldPath) {
    return oldPath;
  }

  const gitHeader = lines.find((line) => line.startsWith("diff --git "));
  const headerMatch = gitHeader ? /^diff --git a\/(.+) b\/(.+)$/.exec(gitHeader) : null;
  return headerMatch?.[2] ?? headerMatch?.[1] ?? "diff";
}

/**
 * @param {string[]} lines
 * @returns {"add" | "delete" | "update"}
 */
function parseDiffChangeKind(lines) {
  if (lines.some((line) => line === "new file mode" || line.startsWith("new file mode "))) {
    return "add";
  }
  if (lines.some((line) => line === "deleted file mode" || line.startsWith("deleted file mode "))) {
    return "delete";
  }
  if (lines.some((line) => line.startsWith("--- ") && line.includes("/dev/null"))) {
    return "add";
  }
  if (lines.some((line) => line.startsWith("+++ ") && line.includes("/dev/null"))) {
    return "delete";
  }
  return "update";
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function extractUnifiedDiff(lines) {
  const firstUnifiedLine = lines.findIndex((line) => line.startsWith("--- ") || line.startsWith("Binary files "));
  const diffLines = firstUnifiedLine >= 0 ? lines.slice(firstUnifiedLine) : lines;
  return trimTrailingNewline(diffLines.join("\n"));
}

/**
 * @param {string} diffText
 * @returns {ParsedGitDiffFile[]}
 */
export function parseGitDiffFiles(diffText) {
  const lines = trimTrailingNewline(diffText).split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return [];
  }

  /** @type {string[][]} */
  const blocks = [];
  /** @type {string[]} */
  let current = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      blocks.push(current);
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks
    .map((block) => ({
      path: parseDiffPath(block),
      changeKind: parseDiffChangeKind(block),
      diff: extractUnifiedDiff(block),
    }))
    .filter((file) => file.diff.length > 0);
}

/**
 * @param {{
 *   command: string,
 *   workdir: string,
 *   context: ExecuteActionContext,
 * }} input
 * @returns {Promise<boolean>}
 */
export async function handleSlashDiffCommand({ command, workdir, context }) {
  if (command !== "diff") {
    return false;
  }

  const result = await runGit(workdir, ["diff", "--no-ext-diff", "--find-renames", "HEAD", "--"]);
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `git diff failed in ${workdir}`;
    await context.reply(contentEvent("error", details));
    return true;
  }

  const files = parseGitDiffFiles(result.stdout);
  if (files.length === 0) {
    await context.reply(contentEvent("tool-result", "No uncommitted changes."));
    return true;
  }

  for (const file of files) {
    await context.reply({
      kind: "file_change",
      path: file.path,
      cwd: workdir,
      changeKind: file.changeKind,
      source: "snapshot",
      diff: file.diff,
    });
  }
  return true;
}
