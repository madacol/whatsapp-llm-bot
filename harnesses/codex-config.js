import { getHarnessConfig, updateHarnessConfig } from "../harness-config.js";
export {
  CODEX_SANDBOX_MODES,
  DEFAULT_CODEX_SANDBOX_MODE,
  getEffectiveCodexSandboxMode,
  normalizeCodexPermissionsMode,
} from "../harness-config.js";

/** @type {Set<NonNullable<HarnessRunConfig["approvalPolicy"]>>} */
export const CODEX_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

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
