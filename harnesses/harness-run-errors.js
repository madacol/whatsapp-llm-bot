import { errorToString } from "../utils.js";

export class ReportedHarnessRunError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(message, cause) {
    super(message);
    this.name = "ReportedHarnessRunError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * @param {unknown} error
 * @returns {error is ReportedHarnessRunError}
 */
export function isReportedHarnessRunError(error) {
  return error instanceof ReportedHarnessRunError;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function getHarnessRunErrorMessage(error) {
  return error instanceof ReportedHarnessRunError ? error.message : errorToString(error);
}

/**
 * @param {unknown} error
 * @param {(message: string) => Promise<void>} onToolError
 * @returns {Promise<ReportedHarnessRunError>}
 */
export async function reportHarnessRunError(error, onToolError) {
  if (error instanceof ReportedHarnessRunError) {
    return error;
  }
  const message = errorToString(error);
  await onToolError(message);
  return new ReportedHarnessRunError(message, error);
}

/**
 * @param {string} message
 * @returns {AgentResult["response"]}
 */
export function buildSdkErrorResponse(message) {
  return [{ type: "text", text: `SDK error: ${message}` }];
}

/**
 * @param {{
 *   existingSessionId: string | null,
 *   resolvedSessionId?: string | null,
 *   clearSession: () => Promise<void>,
 *   log: { warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void },
 *   harnessLabel: string,
 * }} input
 * @returns {Promise<boolean>}
 */
export async function clearStaleHarnessSession(input) {
  if (!input.existingSessionId || input.resolvedSessionId) {
    return false;
  }

  input.log.warn(`${input.harnessLabel} run failed for saved session ${input.existingSessionId}; clearing persisted session`);
  try {
    await input.clearSession();
  } catch (error) {
    input.log.error(`Failed to clear stale ${input.harnessLabel} session ID:`, error);
  }
  return true;
}
