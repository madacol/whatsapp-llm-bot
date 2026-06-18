import { execFile } from "node:child_process";
import { createAppOutputPort } from "./app-output-port.js";

const GIT_DIFF_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * @typedef {{
 *   path: string;
 *   changeKind: "add" | "delete" | "update";
 *   diff: string;
 * }} ParsedGitDiffFile
 */

/**
 * @typedef {{
 *   handled: true;
 *   depth: number;
 * } | {
 *   handled: true;
 *   error: string;
 * } | {
 *   handled: false;
 * }} ParsedSlashDiffCommand
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
 * @param {string} command
 * @returns {ParsedSlashDiffCommand}
 */
function parseSlashDiffCommand(command) {
  const match = /^diff(?:\s+([\s\S]+))?$/i.exec(command.trim());
  if (!match) {
    return { handled: false };
  }
  const rawDepth = match[1]?.trim() ?? "";
  if (!rawDepth) {
    return { handled: true, depth: 0 };
  }
  if (!/^\d+$/.test(rawDepth)) {
    return { handled: true, error: "Usage: `/diff [commit-depth]`, where commit-depth is a non-negative integer." };
  }
  const depth = Number(rawDepth);
  if (!Number.isSafeInteger(depth)) {
    return { handled: true, error: "Usage: `/diff [commit-depth]`, where commit-depth is a safe non-negative integer." };
  }
  return { handled: true, depth };
}

/**
 * @param {number} depth
 * @returns {string}
 */
function gitDiffBaseRevision(depth) {
  return depth === 0 ? "HEAD" : `HEAD~${depth}`;
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
  const appOutput = createAppOutputPort(context);
  const parsedCommand = parseSlashDiffCommand(command);
  if (!parsedCommand.handled) {
    return false;
  }
  if ("error" in parsedCommand) {
    await appOutput.replyWithError(parsedCommand.error);
    return true;
  }

  const result = await runGit(workdir, ["diff", "--no-ext-diff", "--find-renames", gitDiffBaseRevision(parsedCommand.depth), "--"]);
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `git diff failed in ${workdir}`;
    await appOutput.replyWithError(details);
    return true;
  }

  const files = parseGitDiffFiles(result.stdout);
  if (files.length === 0) {
    await appOutput.replyWithToolResult("No uncommitted changes.");
    return true;
  }

  for (const file of files) {
    await appOutput.replyWithFileChange({
      path: file.path,
      cwd: workdir,
      changeKind: file.changeKind,
      source: "snapshot",
      diff: file.diff,
    });
  }
  return true;
}
