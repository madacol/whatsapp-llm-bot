import fs from "node:fs";
import path from "node:path";
import { formatSandboxEscapeConfirmMessage } from "./sandbox-approval.js";

/**
 * Ask the user whether a sandbox escape should be allowed through a poll-style choice hook.
 * @param {import("./sandbox-approval.js").SandboxEscapeRequest} request
 * @param {Required<AgentIOHooks>["onAskUser"]} onAskUser
 * @returns {Promise<boolean>}
 */
export async function requestSandboxEscapeApproval(request, onAskUser) {
  const userChoice = await onAskUser(
    formatSandboxEscapeConfirmMessage(request),
    ["✅ Allow", "❌ Deny"],
  );
  return userChoice !== "❌ Deny";
}

/**
 * Ask the user whether a sandbox escape should be allowed through a confirm-style hook.
 * @param {import("./sandbox-approval.js").SandboxEscapeRequest} request
 * @param {(message: string) => Promise<boolean>} confirm
 * @returns {Promise<boolean>}
 */
export async function confirmSandboxEscape(request, confirm) {
  return confirm(formatSandboxEscapeConfirmMessage(request));
}

/**
 * Add a newly approved writable root to a harness run config without duplicating existing entries.
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {string} additionalDirectory
 * @returns {HarnessRunConfig}
 */
export function appendSandboxWritableRoot(runConfig, additionalDirectory) {
  const existingDirectories = Array.isArray(runConfig?.additionalDirectories)
    ? runConfig.additionalDirectories.filter((directory) => typeof directory === "string" && directory.trim())
    : [];
  if (existingDirectories.includes(additionalDirectory)) {
    return {
      ...runConfig,
      additionalDirectories: existingDirectories,
    };
  }
  return {
    ...runConfig,
    additionalDirectories: [...existingDirectories, additionalDirectory],
  };
}

/**
 * Resolve the directory that should be whitelisted after a sandbox escape approval.
 * File targets whitelist their parent directory; directory targets whitelist themselves.
 * @param {import("./sandbox-approval.js").SandboxEscapeRequest} request
 * @returns {string}
 */
export function resolveSandboxApprovalDirectory(request) {
  const resolvedTarget = request.resolvedTarget
    ?? (typeof request.target === "string" ? path.resolve(request.workdir, request.target) : request.workdir);

  if (looksLikeDirectoryTarget(request, resolvedTarget)) {
    return resolvedTarget;
  }
  return path.dirname(resolvedTarget);
}

/**
 * @param {import("./sandbox-approval.js").SandboxEscapeRequest} request
 * @param {string} resolvedTarget
 * @returns {boolean}
 */
function looksLikeDirectoryTarget(request, resolvedTarget) {
  const rawTarget = request.target ?? "";
  if (
    rawTarget === "."
    || rawTarget === ".."
    || rawTarget.endsWith("/")
    || rawTarget.endsWith(`${path.sep}.`)
    || rawTarget.endsWith(`${path.sep}..`)
  ) {
    return true;
  }

  try {
    return fs.statSync(resolvedTarget).isDirectory();
  } catch {
    return typeof request.command === "string" && /\b(?:cd|mkdir)\b/.test(request.command);
  }
}
