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
  const cdMatch = command.match(/(?:^|[;&|]\s*|\s)cd\s+(?<target>"[^"]+"|'[^']+'|`[^`]+`|[^\s;&|]+)/);
  const cdTarget = stripShellQuotes(cdMatch?.groups?.target ?? null);
  if (cdTarget && resolvesOutsideWorkspace(cdTarget, workdir)) {
    return cdTarget;
  }

  const pathMatches = command.matchAll(/(?:^|[;&|]\s*|\s)(?<target>~\/[^\s;&|]*|\/[^\s;&|]*|\.\.\/[^\s;&|]*|\.\.(?:$|(?=[\s;&|])))/g);
  for (const match of pathMatches) {
    const candidate = stripShellQuotes(match.groups?.target ?? null);
    if (candidate && resolvesOutsideWorkspace(candidate, workdir)) {
      return candidate;
    }
  }

  return null;
}

/**
 * @param {string | null} value
 * @returns {string | null}
 */
function stripShellQuotes(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const firstChar = trimmed[0];
  const lastChar = trimmed.at(-1);
  if ((firstChar === "\"" || firstChar === "'" || firstChar === "`") && firstChar === lastChar) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
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
