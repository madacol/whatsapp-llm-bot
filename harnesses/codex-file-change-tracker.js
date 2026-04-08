/**
 * @typedef {{
 *   itemId: string,
 *   changes: Array<{
 *     path: string,
 *     summary?: string,
 *     diff?: string,
 *     kind?: "add" | "delete" | "update",
 *   }>,
 *   decision: "accept" | "cancel" | null,
 * }} CodexTrackedFileChange
 */

/**
 * Track App Server file changes by `itemId` so proposal, approval, and final
 * application can share the same transient record.
 * @returns {{
 *   rememberStarted: (itemId: string, changes: CodexTrackedFileChange["changes"]) => void,
 *   get: (itemId: string) => CodexTrackedFileChange | null,
 *   markDecision: (itemId: string, decision: "accept" | "cancel") => void,
 *   takeCompletion: (itemId: string, changes: CodexTrackedFileChange["changes"]) => CodexTrackedFileChange | null,
 * }}
 */
export function createCodexFileChangeTracker() {
  /** @type {Map<string, CodexTrackedFileChange>} */
  const tracked = new Map();

  return {
    rememberStarted,
    get,
    markDecision,
    takeCompletion,
  };

  /**
   * @param {string} itemId
   * @param {CodexTrackedFileChange["changes"]} changes
   * @returns {void}
   */
  function rememberStarted(itemId, changes) {
    tracked.set(itemId, {
      itemId,
      changes: changes.map((change) => ({ ...change })),
      decision: null,
    });
  }

  /**
   * @param {string} itemId
   * @returns {CodexTrackedFileChange | null}
   */
  function get(itemId) {
    return tracked.get(itemId) ?? null;
  }

  /**
   * @param {string} itemId
   * @param {"accept" | "cancel"} decision
   * @returns {void}
   */
  function markDecision(itemId, decision) {
    const existing = tracked.get(itemId);
    if (!existing) {
      return;
    }
    existing.decision = decision;
  }

  /**
   * @param {string} itemId
   * @param {CodexTrackedFileChange["changes"]} changes
   * @returns {CodexTrackedFileChange | null}
   */
  function takeCompletion(itemId, changes) {
    const existing = tracked.get(itemId) ?? null;
    if (existing) {
      tracked.delete(itemId);
      return {
        ...existing,
        changes: changes.length > 0 ? changes.map((change) => ({ ...change })) : existing.changes,
      };
    }
    return changes.length > 0
      ? {
        itemId,
        changes: changes.map((change) => ({ ...change })),
        decision: null,
      }
      : null;
  }
}
