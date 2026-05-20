/**
 * @typedef {{
 *   abortController: AbortController,
 *   done: Promise<unknown>,
 *   steer?: (text: string) => boolean | Promise<boolean>,
 *   interrupt?: () => boolean | Promise<boolean>,
 *   aborted: boolean,
 * }} ActiveHarnessSessionHandle
 */

/**
 * @param {string | HarnessSessionRef} key
 * @returns {string}
 */
function normalizeSessionKey(key) {
  return typeof key === "string" ? key : key.id;
}

/**
 * Shared active-session directory for harnesses with one active runtime handle
 * per chat/session key. It centralizes live input, cancellation, and shutdown
 * drain behavior while leaving provider runtimes to own the actual process/RPC
 * handle lifecycle.
 * @param {{
 *   label: string,
 *   onInterruptError?: (error: unknown) => void,
 * }} options
 * @returns {{
 *   register: (key: string | HarnessSessionRef, handle: ActiveHarnessSessionHandle) => void,
 *   unregister: (key: string | HarnessSessionRef, handle?: ActiveHarnessSessionHandle) => void,
 *   get: (key: string | HarnessSessionRef) => ActiveHarnessSessionHandle | undefined,
 *   listKeys: () => string[],
 *   injectMessage: (key: string | HarnessSessionRef, text: string) => Promise<boolean>,
 *   cancel: (key: string | HarnessSessionRef) => boolean,
 *   listActiveSessions: () => string[],
 *   waitForIdle: () => Promise<string[]>,
 * }}
 */
export function createActiveSessionDirectory(options) {
  /** @type {Map<string, ActiveHarnessSessionHandle>} */
  const activeSessions = new Map();

  /**
   * @param {string | HarnessSessionRef} key
   * @returns {ActiveHarnessSessionHandle | undefined}
   */
  function get(key) {
    return activeSessions.get(normalizeSessionKey(key));
  }

  return {
    register(key, handle) {
      activeSessions.set(normalizeSessionKey(key), handle);
    },
    unregister(key, handle) {
      const normalizedKey = normalizeSessionKey(key);
      if (handle && activeSessions.get(normalizedKey) !== handle) {
        return;
      }
      activeSessions.delete(normalizedKey);
    },
    get,
    listKeys() {
      return [...activeSessions.keys()];
    },
    listActiveSessions() {
      return [...activeSessions.keys()];
    },
    async injectMessage(key, text) {
      const active = get(key);
      if (!active?.steer || !text) {
        return false;
      }
      return !!(await active.steer(text));
    },
    cancel(key) {
      const active = get(key);
      if (!active) {
        return false;
      }
      active.aborted = true;
      if (active.interrupt) {
        void Promise.resolve(active.interrupt()).catch((error) => {
          options.onInterruptError?.(error);
          active.abortController.abort();
        });
        return true;
      }
      active.abortController.abort();
      return true;
    },
    async waitForIdle() {
      const keys = [...activeSessions.keys()];
      await Promise.allSettled(keys.map((key) => activeSessions.get(key)?.done));
      return keys;
    },
  };
}
