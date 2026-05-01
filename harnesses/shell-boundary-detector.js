import path from "node:path";

/**
 * Find a shell path reference that would leave the current workspace boundary.
 * Returns the original shell token that triggered the escape, or null when the
 * command stays within the workspace.
 * @param {string} command
 * @param {string} workdir
 * @returns {string | null}
 */
export function findEscapedShellTarget(command, workdir) {
  const words = splitShellWords(command);
  for (let index = 0; index < words.length - 1; index += 1) {
    if (words[index] !== "cd") {
      continue;
    }
    const cdTarget = words[index + 1];
    if (cdTarget && resolvesOutsideWorkspace(cdTarget, workdir)) {
      return cdTarget;
    }
  }

  for (const word of words) {
    if (!isBoundaryPathReference(word)) {
      continue;
    }
    if (resolvesOutsideWorkspace(word, workdir)) {
      return word;
    }
  }

  return null;
}

/**
 * Split enough shell syntax to identify path tokens without treating
 * backslash-escaped spaces as argument separators.
 * @param {string} command
 * @returns {string[]}
 */
function splitShellWords(command) {
  /** @type {string[]} */
  const words = [];
  let current = "";
  /** @type {"'" | "\"" | "`" | null} */
  let quote = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote !== "'" && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index += 1;
      continue;
    }

    if (/\s/.test(char) || char === ";" || char === "&" || char === "|") {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    words.push(current);
  }
  return words;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isBoundaryPathReference(value) {
  return value.startsWith("~/")
    || value.startsWith("/")
    || value.startsWith("../")
    || value === "..";
}

/**
 * @param {string} candidate
 * @param {string} workdir
 * @returns {boolean}
 */
function resolvesOutsideWorkspace(candidate, workdir) {
  if (candidate.startsWith("~/")) {
    return true;
  }

  if (!candidate.startsWith("/") && !candidate.startsWith("..")) {
    return false;
  }

  const resolvedPath = path.resolve(workdir, candidate);
  return !isPathInsideWorkspace(resolvedPath, workdir);
}

/**
 * @param {string} candidatePath
 * @param {string} workdir
 * @returns {boolean}
 */
function isPathInsideWorkspace(candidatePath, workdir) {
  const relativePath = path.relative(workdir, candidatePath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
