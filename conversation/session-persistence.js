/**
 * @typedef {{
 *   saveHarnessSession: import("../store.js").Store["saveHarnessSession"],
 *   archiveHarnessSession: import("../store.js").Store["archiveHarnessSession"],
 *   getHarnessSessionHistory: import("../store.js").Store["getHarnessSessionHistory"],
 *   restoreHarnessSession: import("../store.js").Store["restoreHarnessSession"],
 *   pushHarnessForkStack: import("../store.js").Store["pushHarnessForkStack"],
 *   popHarnessForkStack: import("../store.js").Store["popHarnessForkStack"],
 * }} AgentSessionPersistenceStore
 *
 * @typedef {{
 *   saveActiveSession: import("../store.js").Store["saveHarnessSession"],
 *   archiveActiveSession: import("../store.js").Store["archiveHarnessSession"],
 *   getArchivedSessions: import("../store.js").Store["getHarnessSessionHistory"],
 *   restoreArchivedSession: import("../store.js").Store["restoreHarnessSession"],
 *   pushForkedSession: import("../store.js").Store["pushHarnessForkStack"],
 *   popForkedSession: import("../store.js").Store["popHarnessForkStack"],
 * }} AgentSessionPersistence
 */

/**
 * Translate legacy harness-session storage fields into the Agent Runtime's
 * Session vocabulary. The chat config schema can keep compatibility names while
 * runtime modules consume this narrower Session interface.
 * @param {AgentSessionPersistenceStore} store
 * @returns {AgentSessionPersistence}
 */
export function createAgentSessionPersistence(store) {
  return {
    saveActiveSession: store.saveHarnessSession,
    archiveActiveSession: store.archiveHarnessSession,
    getArchivedSessions: store.getHarnessSessionHistory,
    restoreArchivedSession: store.restoreHarnessSession,
    pushForkedSession: store.pushHarnessForkStack,
    popForkedSession: store.popHarnessForkStack,
  };
}
