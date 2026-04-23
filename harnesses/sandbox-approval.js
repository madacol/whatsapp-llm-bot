import path from "node:path";
import os from "node:os";
import { findEscapedShellTarget } from "./shell-boundary-detector.js";

/** @typedef {"path" | "command"} SandboxEscapeKind */

/**
 * @typedef {{
 *   toolName: string,
 *   kind: SandboxEscapeKind,
 *   summary: string,
 *   workdir: string,
 *   target?: string,
 *   command?: string,
 *   resolvedTarget?: string,
 * }} SandboxEscapeRequest
 */

/**
 * Determine whether a tool invocation wants to operate outside the current workspace boundary.
 * Returns null when the invocation stays within the workspace or when full access is enabled.
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @param {{
 *   workdir?: string | null,
 *   sandboxMode?: HarnessRunConfig["sandboxMode"] | null,
 *   additionalWritableRoots?: string[] | null,
 * }} options
 * @returns {SandboxEscapeRequest | null}
 */
export function getSandboxEscapeRequest(toolName, input, options) {
  const sandboxMode = options.sandboxMode ?? "workspace-write";
  const workdir = typeof options.workdir === "string" && options.workdir.trim()
    ? path.resolve(options.workdir)
    : null;
  const allowedRoots = getAllowedRoots(workdir, options.additionalWritableRoots ?? null);

  if (!workdir || sandboxMode === "danger-full-access") {
    return null;
  }

  const normalizedToolName = toolName.trim();

  if (isFileBoundaryTool(normalizedToolName)) {
    const filePath = extractPathInput(input);
    if (!filePath) {
      return null;
    }
    const escapedTarget = resolveEscapedPath(filePath, allowedRoots, workdir);
    if (!escapedTarget) {
      return null;
    }
    return {
      toolName: normalizedToolName,
      kind: "path",
      summary: `Access \`${escapedTarget}\` outside the workspace \`${workdir}\`.`,
      target: escapedTarget,
      resolvedTarget: escapedTarget,
      workdir,
    };
  }

  if (isShellTool(normalizedToolName)) {
    const command = extractCommandInput(input);
    if (!command) {
      return null;
    }
    const escapedTarget = findEscapedShellTarget(command, workdir);
    if (!escapedTarget) {
      return null;
    }
    const resolvedTarget = resolveSandboxTargetPath(escapedTarget, workdir);
    if (resolvedTarget && isPathInsideAllowedRoots(resolvedTarget, allowedRoots)) {
      return null;
    }
    return {
      toolName: normalizedToolName,
      kind: "command",
      summary: `Run a shell command that targets \`${escapedTarget}\` outside the workspace \`${workdir}\`.`,
      command,
      target: escapedTarget,
      ...(resolvedTarget ? { resolvedTarget } : {}),
      workdir,
    };
  }

  return null;
}

/**
 * Format a confirmation message for a sandbox escape request.
 * @param {SandboxEscapeRequest} request
 * @returns {string}
 */
export function formatSandboxEscapeConfirmMessage(request) {
  /** @type {string[]} */
  const lines = [
    "⚠️ *Sandbox escape request*",
    "",
    `\`${request.toolName}\` wants to leave the workspace boundary.`,
    "",
    request.summary,
  ];

  if (request.command) {
    lines.push("", "```bash", request.command, "```");
  }

  lines.push("", "React 👍 to allow or 👎 to deny.");
  return lines.join("\n");
}

/**
 * @param {string} toolName
 * @returns {boolean}
 */
function isFileBoundaryTool(toolName) {
  return new Set([
    "read_file",
    "write_file",
    "edit_file",
    "Read",
    "Write",
    "Edit",
    "NotebookEdit",
  ]).has(toolName);
}

/**
 * @param {string} toolName
 * @returns {boolean}
 */
function isShellTool(toolName) {
  return toolName === "run_bash" || toolName === "Bash";
}

/**
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
function extractPathInput(input) {
  const candidateKeys = ["file_path", "path", "notebook_path"];
  for (const key of candidateKeys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
function extractCommandInput(input) {
  const value = input.command;
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * @param {string} candidatePath
 * @param {string[]} allowedRoots
 * @param {string} workdir
 * @returns {string | null}
 */
function resolveEscapedPath(candidatePath, allowedRoots, workdir) {
  const resolvedPath = path.resolve(workdir, candidatePath);
  return isPathInsideAllowedRoots(resolvedPath, allowedRoots) ? null : resolvedPath;
}

/**
 * @param {string | null} workdir
 * @param {string[] | null | undefined} additionalWritableRoots
 * @returns {string[]}
 */
function getAllowedRoots(workdir, additionalWritableRoots) {
  /** @type {string[]} */
  const allowedRoots = [];
  if (workdir) {
    allowedRoots.push(workdir);
  }
  if (Array.isArray(additionalWritableRoots)) {
    for (const root of additionalWritableRoots) {
      if (typeof root !== "string" || !root.trim()) {
        continue;
      }
      allowedRoots.push(path.resolve(root));
    }
  }
  return allowedRoots;
}

/**
 * @param {string} candidate
 * @param {string} workdir
 * @returns {string | null}
 */
function resolveSandboxTargetPath(candidate, workdir) {
  if (!candidate.trim()) {
    return null;
  }
  if (candidate.startsWith("~/")) {
    return path.join(os.homedir(), candidate.slice(2));
  }
  return path.resolve(workdir, candidate);
}

/**
 * @param {string} candidatePath
 * @param {string[]} allowedRoots
 * @returns {boolean}
 */
function isPathInsideAllowedRoots(candidatePath, allowedRoots) {
  return allowedRoots.some((root) => {
    const relativePath = path.relative(root, candidatePath);
    return relativePath === ""
      || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  });
}
