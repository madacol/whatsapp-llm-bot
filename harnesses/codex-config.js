import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CODEX_SANDBOX_MODES,
  getHarnessConfig,
  updateHarnessConfig,
} from "../harness-config.js";
import { openCodexAppServerConnection } from "./codex-app-server-client.js";
export {
  CODEX_SANDBOX_MODES,
  DEFAULT_CODEX_SANDBOX_MODE,
  getEffectiveCodexSandboxMode,
  normalizeCodexPermissionsMode,
} from "../harness-config.js";

/** @type {Set<NonNullable<HarnessRunConfig["approvalPolicy"]>>} */
export const CODEX_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);

/** @type {NonNullable<HarnessRunConfig["approvalPolicy"]>[]} */
const FALLBACK_CODEX_APPROVAL_POLICIES = ["untrusted", "on-request", "never"];
const execFileAsync = promisify(execFile);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is NonNullable<HarnessRunConfig["approvalPolicy"]>}
 */
export function isCodexApprovalPolicy(value) {
  return CODEX_APPROVAL_POLICIES.has(/** @type {NonNullable<HarnessRunConfig["approvalPolicy"]>} */ (value));
}

/**
 * @param {unknown} response
 * @returns {NonNullable<HarnessRunConfig["approvalPolicy"]>[]}
 */
export function extractCodexApprovalPolicyOptions(response) {
  if (!isObjectRecord(response) || !isObjectRecord(response.requirements)) {
    return [];
  }
  const rawPolicies = response.requirements.allowedApprovalPolicies;
  if (!Array.isArray(rawPolicies)) {
    return [];
  }
  const options = rawPolicies.filter(isCodexApprovalPolicy);
  return [...new Set(options)];
}

/**
 * @param {unknown} response
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]>[]}
 */
export function extractCodexSandboxModeOptions(response) {
  if (!isObjectRecord(response) || !isObjectRecord(response.requirements)) {
    return [];
  }
  const rawModes = response.requirements.allowedSandboxModes;
  if (!Array.isArray(rawModes)) {
    return [];
  }
  const options = rawModes.filter((value) => typeof value === "string" && CODEX_SANDBOX_MODES.has(/** @type {HarnessRunConfig["sandboxMode"]} */ (value)));
  return /** @type {NonNullable<HarnessRunConfig["sandboxMode"]>[]} */ ([...new Set(options)]);
}

/**
 * @param {string} helpText
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]>[]}
 */
export function extractCodexSandboxModeOptionsFromHelp(helpText) {
  const match = helpText.match(/\[possible values:\s*([^\]]+)\]/i);
  if (!match) {
    return [];
  }
  const options = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => CODEX_SANDBOX_MODES.has(/** @type {HarnessRunConfig["sandboxMode"]} */ (value)));
  return /** @type {NonNullable<HarnessRunConfig["sandboxMode"]>[]} */ ([...new Set(options)]);
}

/**
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]>[]}
 */
function getFallbackCodexSandboxModes() {
  return /** @type {NonNullable<HarnessRunConfig["sandboxMode"]>[]} */ ([...CODEX_SANDBOX_MODES]);
}

/**
 * @param {string} helpText
 * @returns {NonNullable<HarnessRunConfig["approvalPolicy"]>[]}
 */
export function extractCodexApprovalPolicyOptionsFromHelp(helpText) {
  /** @type {NonNullable<HarnessRunConfig["approvalPolicy"]>[]} */
  const options = [];
  const optionPattern = /^\s*-\s+([a-z][a-z-]*):/gm;
  let match = optionPattern.exec(helpText);
  while (match) {
    const value = match[1];
    if (isCodexApprovalPolicy(value)) {
      options.push(value);
    }
    match = optionPattern.exec(helpText);
  }
  return [...new Set(options)];
}

/**
 * @returns {Promise<NonNullable<HarnessRunConfig["approvalPolicy"]>[]>}
 */
async function getCodexApprovalPolicyOptionsFromHelp() {
  try {
    const { stdout } = await execFileAsync("codex", ["--help"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const options = extractCodexApprovalPolicyOptionsFromHelp(stdout);
    return options.length > 0 ? options : [...FALLBACK_CODEX_APPROVAL_POLICIES];
  } catch {
    return [...FALLBACK_CODEX_APPROVAL_POLICIES];
  }
}

/**
 * @returns {Promise<NonNullable<HarnessRunConfig["sandboxMode"]>[]>}
 */
async function getCodexSandboxModeOptionsFromHelp() {
  try {
    const { stdout } = await execFileAsync("codex", ["--help"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const options = extractCodexSandboxModeOptionsFromHelp(stdout);
    return options.length > 0 ? options : getFallbackCodexSandboxModes();
  } catch {
    return getFallbackCodexSandboxModes();
  }
}

/**
 * @param {unknown} response
 * @returns {NonNullable<HarnessRunConfig["approvalsReviewer"]>[]}
 */
export function extractCodexApprovalsReviewerOptions(response) {
  if (!isObjectRecord(response) || !isObjectRecord(response.requirements)) {
    return [];
  }
  const requirementKeys = [
    "allowedApprovalsReviewers",
    "allowedApprovalReviewers",
    "allowedApprovalsReviewerOptions",
    "allowedApprovalReviewerOptions",
  ];
  /** @type {string[]} */
  const rawReviewers = [];
  for (const key of requirementKeys) {
    const value = response.requirements[key];
    if (Array.isArray(value)) {
      rawReviewers.push(...value.filter((item) => typeof item === "string"));
    }
  }
  return /** @type {NonNullable<HarnessRunConfig["approvalsReviewer"]>[]} */ ([...new Set(rawReviewers)]);
}

/**
 * @param {string} typescriptSource
 * @returns {NonNullable<HarnessRunConfig["approvalsReviewer"]>[]}
 */
export function extractCodexApprovalsReviewerOptionsFromTypescript(typescriptSource) {
  const match = typescriptSource.match(/export\s+type\s+ApprovalsReviewer\s*=\s*([^;]+);/);
  if (!match) {
    return [];
  }
  /** @type {string[]} */
  const options = [];
  const stringLiteralPattern = /"([^"]+)"/g;
  let literalMatch = stringLiteralPattern.exec(match[1]);
  while (literalMatch) {
    options.push(literalMatch[1]);
    literalMatch = stringLiteralPattern.exec(match[1]);
  }
  return /** @type {NonNullable<HarnessRunConfig["approvalsReviewer"]>[]} */ ([...new Set(options)]);
}

/**
 * @returns {Promise<NonNullable<HarnessRunConfig["approvalsReviewer"]>[]>}
 */
async function getCodexApprovalsReviewerOptionsFromGeneratedTypes() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-server-types-"));
  try {
    await execFileAsync("codex", ["app-server", "generate-ts", "--out", outDir], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const source = await fs.readFile(path.join(outDir, "v2", "ApprovalsReviewer.ts"), "utf8");
    return extractCodexApprovalsReviewerOptionsFromTypescript(source);
  } catch {
    return [];
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @returns {Promise<NonNullable<HarnessRunConfig["sandboxMode"]>[]>}
 */
export async function getCodexSandboxModeOptions() {
  try {
    const connection = await openCodexAppServerConnection();
    try {
      const response = await connection.sendRequest("configRequirements/read");
      const options = extractCodexSandboxModeOptions(response);
      return options.length > 0 ? options : await getCodexSandboxModeOptionsFromHelp();
    } finally {
      await connection.close();
    }
  } catch {
    return getCodexSandboxModeOptionsFromHelp();
  }
}

/**
 * @returns {Promise<NonNullable<HarnessRunConfig["approvalsReviewer"]>[]>}
 */
export async function getCodexApprovalsReviewerOptions() {
  try {
    const connection = await openCodexAppServerConnection();
    try {
      const response = await connection.sendRequest("configRequirements/read");
      const options = extractCodexApprovalsReviewerOptions(response);
      return options.length > 0 ? options : await getCodexApprovalsReviewerOptionsFromGeneratedTypes();
    } finally {
      await connection.close();
    }
  } catch {
    return getCodexApprovalsReviewerOptionsFromGeneratedTypes();
  }
}

/**
 * Read the approval policies allowed by the running Codex app-server.
 * Falls back to the installed CLI help if the app-server cannot provide
 * requirements.
 * @returns {Promise<NonNullable<HarnessRunConfig["approvalPolicy"]>[]>}
 */
export async function getCodexApprovalPolicyOptions() {
  try {
    const connection = await openCodexAppServerConnection();
    try {
      const response = await connection.sendRequest("configRequirements/read");
      const options = extractCodexApprovalPolicyOptions(response);
      return options.length > 0 ? options : [...FALLBACK_CODEX_APPROVAL_POLICIES];
    } finally {
      await connection.close();
    }
  } catch {
    return getCodexApprovalPolicyOptionsFromHelp();
  }
}

/**
 * Read the generic harness_config JSONB for a chat.
 * @param {string} chatId
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getCodexConfig(chatId) {
  return getHarnessConfig(chatId, "codex");
}

/**
 * Update the generic harness_config JSONB for a chat.
 * Null/undefined values remove keys from the stored config.
 * @param {string} chatId
 * @param {Record<string, unknown>} patch
 * @returns {Promise<void>}
 */
export async function updateCodexConfig(chatId, patch) {
  await updateHarnessConfig(chatId, "codex", patch);
}

/**
 * Persist the current Codex session through the generic API when available.
 * @param {Session} session
 * @param {string | null} sessionId
 * @returns {Promise<void>}
 */
export async function saveCodexSession(session, sessionId) {
  if (session.saveHarnessSession) {
    await session.saveHarnessSession(
      session.chatId,
      sessionId ? { id: sessionId, kind: "codex" } : null,
    );
  }
}

/**
 * @param {Session} session
 * @returns {string | null}
 */
export function getCodexSessionId(session) {
  if (session.harnessSession?.kind === "codex") {
    return session.harnessSession.id;
  }
  return null;
}
