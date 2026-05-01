import { getHarnessConfig, updateHarnessConfig } from "../harness-config.js";

/** @type {Record<NonNullable<HarnessRunConfig["reasoningEffort"]>, "low" | "medium" | "high" | "xhigh">} */
export const PI_REASONING_LEVELS = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/**
 * @param {string} chatId
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getPiConfig(chatId) {
  return getHarnessConfig(chatId, "pi");
}

/**
 * @param {string} chatId
 * @param {Record<string, unknown>} patch
 * @returns {Promise<void>}
 */
export async function updatePiConfig(chatId, patch) {
  await updateHarnessConfig(chatId, "pi", patch);
}

/**
 * @param {Session} session
 * @param {string | null} sessionPath
 * @returns {Promise<void>}
 */
export async function savePiSession(session, sessionPath) {
  if (!session.saveHarnessSession) {
    return;
  }
  await session.saveHarnessSession(
    session.chatId,
    sessionPath ? { id: sessionPath, kind: "pi" } : null,
  );
}

/**
 * @param {Session} session
 * @returns {string | null}
 */
export function getPiSessionPath(session) {
  if (session.harnessSession?.kind === "pi") {
    return session.harnessSession.id;
  }
  return null;
}

/**
 * @param {HarnessRunConfig["reasoningEffort"] | undefined} effort
 * @returns {"low" | "medium" | "high" | "xhigh" | null}
 */
export function toPiThinkingLevel(effort) {
  if (!effort) {
    return null;
  }
  return PI_REASONING_LEVELS[effort] ?? null;
}
