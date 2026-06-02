import fs from "node:fs/promises";
import path from "node:path";

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
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {string[]}
 */
export function getProtectedPathPatterns(runConfig) {
  return Array.isArray(runConfig?.protectedPaths)
    ? runConfig.protectedPaths.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : [];
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {string} filePath
 * @returns {{ protected: boolean, pattern?: string, relativePath: string, resolvedPath: string }}
 */
export function matchProtectedPath(runConfig, filePath) {
  const workdir = path.resolve(runConfig?.workdir ?? process.cwd());
  const resolvedPath = path.resolve(workdir, filePath);
  const relativePath = normalizeSlashes(path.relative(workdir, resolvedPath));
  if (relativePath.startsWith("../") || relativePath === "..") {
    return { protected: false, relativePath, resolvedPath };
  }
  for (const pattern of getProtectedPathPatterns(runConfig)) {
    if (globToRegExp(pattern).test(relativePath)) {
      return { protected: true, pattern, relativePath, resolvedPath };
    }
  }
  return { protected: false, relativePath, resolvedPath };
}

/**
 * @param {{
 *   runConfig?: HarnessRunConfig,
 *   filePath: string,
 *   action: string,
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 * }} input
 * @returns {Promise<{ allowed: boolean, match: ReturnType<typeof matchProtectedPath> }>}
 */
export async function requestProtectedPathApproval(input) {
  const match = matchProtectedPath(input.runConfig, input.filePath);
  if (!match.protected) {
    return { allowed: true, match };
  }
  const choice = await input.hooks.onAskUser(
    `Allow protected path change?`,
    ["Allow once", "Deny"],
    undefined,
    [`${input.action}: ${match.relativePath}`, `Matched protected pattern: ${match.pattern}`],
  );
  return { allowed: choice === "Allow once", match };
}

/**
 * @param {{ resolvedPath: string, oldText?: string, hadOldText: boolean }} input
 * @returns {Promise<void>}
 */
export async function restoreProtectedPath(input) {
  if (input.hadOldText) {
    await fs.mkdir(path.dirname(input.resolvedPath), { recursive: true });
    await fs.writeFile(input.resolvedPath, input.oldText ?? "", "utf8");
    return;
  }
  await fs.rm(input.resolvedPath, { force: true });
}
