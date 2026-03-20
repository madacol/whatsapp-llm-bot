import { getRootDb } from "../db.js";

/** @type {Set<HarnessRunConfig["sandboxMode"]>} */
export const CODEX_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/** @type {Set<NonNullable<HarnessRunConfig["approvalPolicy"]>>} */
export const CODEX_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

/** @type {NonNullable<HarnessRunConfig["sandboxMode"]>} */
export const DEFAULT_CODEX_SANDBOX_MODE = "workspace-write";

/**
 * Read the generic harness_config JSONB for a chat.
 * @param {string} chatId
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getCodexConfig(chatId) {
  const db = getRootDb();
  const { rows: [row] } = await db.sql`SELECT harness_config FROM chats WHERE chat_id = ${chatId}`;
  const config = row?.harness_config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
}

/**
 * Update the generic harness_config JSONB for a chat.
 * Null/undefined values remove keys from the stored config.
 * @param {string} chatId
 * @param {Record<string, unknown>} patch
 * @returns {Promise<void>}
 */
export async function updateCodexConfig(chatId, patch) {
  const db = getRootDb();
  const current = await getCodexConfig(chatId);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) {
      delete current[key];
    } else {
      current[key] = value;
    }
  }
  await db.sql`UPDATE chats SET harness_config = ${JSON.stringify(current)} WHERE chat_id = ${chatId}`;
}

/**
 * @param {Record<string, unknown>} config
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]>}
 */
export function getEffectiveCodexSandboxMode(config) {
  if (typeof config.sandboxMode === "string" && CODEX_SANDBOX_MODES.has(/** @type {HarnessRunConfig["sandboxMode"]} */ (config.sandboxMode))) {
    return /** @type {NonNullable<HarnessRunConfig["sandboxMode"]>} */ (config.sandboxMode);
  }
  return DEFAULT_CODEX_SANDBOX_MODE;
}

/**
 * @param {string} value
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]> | null}
 */
export function normalizeCodexPermissionsMode(value) {
  if (value === "write" || value === "workspace" || value === "workspace-write") {
    return "workspace-write";
  }
  if (value === "readonly" || value === "read-only" || value === "read") {
    return "read-only";
  }
  if (value === "full" || value === "full-access" || value === "danger-full-access") {
    return "danger-full-access";
  }
  return null;
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
