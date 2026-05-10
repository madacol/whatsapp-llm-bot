import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getHarnessConfig, updateHarnessConfig } from "../harness-config.js";
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
