/**
 * @typedef {{
 *   status: "started" | "buffered" | "injected";
 * }} HarnessRunDecision
 */

/**
 * @typedef {{
 *   chatId: string;
 *   text: string;
 *   harness: AgentHarness;
 * }} PendingLiveInput
 */

/**
 * @typedef {{
 *   bufferedTexts: string[];
 *   queuedTurns: ChatTurn[];
 *   pendingLiveInputs: PendingLiveInput[];
 *   liveInputRetryTimer: ReturnType<typeof setTimeout> | null;
 *   isActive: boolean;
 *   harness: AgentHarness;
 *   ownerKey: string | null;
 * }} PendingRunState
 */

/**
 * @typedef {{
 *   liveInputRetryDelayMs?: number;
 * }} HarnessRunCoordinatorOptions
 */

/**
 * Coordinator for harness run lifecycle at the chat level.
 *
 * This owns the generic policy around:
 * - one active/pending run per chat
 * - buffering messages that arrive during setup
 * - injecting follow-up text into an active harness when supported
 *
 * The coordinator does not execute runs itself; it only mediates lifecycle.
 *
 * @returns {{
 *   beginRun: (input: { turn: ChatTurn, userText: string, harness?: AgentHarness | null, ownerKey?: string | null }) => Promise<HarnessRunDecision>,
 *   hasPendingRun: (chatId: string) => boolean,
 *   markRunActive: (chatId: string) => void,
 *   consumeBufferedTexts: (chatId: string) => string[],
 *   finishRun: (chatId: string) => ChatTurn | null,
 * }}
 * @param {HarnessRunCoordinatorOptions} [options]
 */
export function createHarnessRunCoordinator(options = {}) {
  const liveInputRetryDelayMs = options.liveInputRetryDelayMs ?? 50;
  /** @type {Map<string, PendingRunState>} */
  const pendingRuns = new Map();

  /**
   * @param {AgentHarness} harness
   * @returns {harness is AgentHarness & { injectMessage: NonNullable<AgentHarness["injectMessage"]> }}
   */
  function canInjectLiveInput(harness) {
    return harness.getCapabilities().supportsLiveInput && typeof harness.injectMessage === "function";
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {AgentHarness & { injectMessage: NonNullable<AgentHarness["injectMessage"]> }} harness
   * @returns {Promise<boolean>}
   */
  async function tryInjectLiveInput(chatId, text, harness) {
    try {
      return !!(await harness.injectMessage(chatId, text));
    } catch {
      return false;
    }
  }

  /**
   * @param {string} chatId
   * @returns {Promise<void>}
   */
  async function retryPendingLiveInputs(chatId) {
    const pending = pendingRuns.get(chatId);
    if (!pending || !pending.isActive) {
      return;
    }
    pending.liveInputRetryTimer = null;

    /** @type {PendingLiveInput[]} */
    const remaining = [];
    for (const liveInput of pending.pendingLiveInputs) {
      if (!canInjectLiveInput(liveInput.harness)) {
        remaining.push(liveInput);
        continue;
      }
      const injected = await tryInjectLiveInput(liveInput.chatId, liveInput.text, liveInput.harness);
      if (!injected) {
        remaining.push(liveInput);
      }
    }

    pending.pendingLiveInputs = remaining;
    if (remaining.length > 0) {
      scheduleLiveInputRetry(chatId, pending);
    }
  }

  /**
   * @param {string} chatId
   * @param {PendingRunState} pending
   * @returns {void}
   */
  function scheduleLiveInputRetry(chatId, pending) {
    if (pending.liveInputRetryTimer) {
      return;
    }
    pending.liveInputRetryTimer = setTimeout(() => {
      void retryPendingLiveInputs(chatId);
    }, liveInputRetryDelayMs);
  }

  /**
   * @param {string} chatId
   * @param {PendingRunState} pending
   * @param {string} text
   * @param {AgentHarness} harness
   * @returns {void}
   */
  function queueLiveInputRetry(chatId, pending, text, harness) {
    pending.pendingLiveInputs.push({ chatId, text, harness });
    scheduleLiveInputRetry(chatId, pending);
  }

  /**
   * @param {PendingRunState} pending
   * @returns {void}
   */
  function clearLiveInputRetry(pending) {
    if (pending.liveInputRetryTimer) {
      clearTimeout(pending.liveInputRetryTimer);
      pending.liveInputRetryTimer = null;
    }
    pending.pendingLiveInputs.length = 0;
  }

  return {
    async beginRun({ turn, userText, harness, ownerKey = null }) {
      const { chatId } = turn;
      const pending = pendingRuns.get(chatId);
      if (pending) {
        const sameOwner = !ownerKey || !pending.ownerKey || ownerKey === pending.ownerKey;
        if (pending.isActive && sameOwner && userText && canInjectLiveInput(pending.harness)) {
          if (await tryInjectLiveInput(chatId, userText, pending.harness)) {
            return { status: "injected" };
          }
          queueLiveInputRetry(chatId, pending, userText, pending.harness);
          return { status: "injected" };
        }
        if (pending.isActive) {
          pending.queuedTurns.push(turn);
          return { status: "buffered" };
        }
        if (sameOwner && userText) {
          pending.bufferedTexts.push(userText);
        } else {
          pending.queuedTurns.push(turn);
        }
        return { status: "buffered" };
      }

      if (!harness) {
        throw new Error("Harness is required to start a run.");
      }
      pendingRuns.set(chatId, {
        bufferedTexts: [],
        queuedTurns: [],
        pendingLiveInputs: [],
        liveInputRetryTimer: null,
        isActive: false,
        harness,
        ownerKey,
      });
      return { status: "started" };
    },

    hasPendingRun(chatId) {
      return pendingRuns.has(chatId);
    },

    markRunActive(chatId) {
      const pending = pendingRuns.get(chatId);
      if (pending) {
        pending.isActive = true;
      }
    },

    consumeBufferedTexts(chatId) {
      const pending = pendingRuns.get(chatId);
      if (!pending || pending.bufferedTexts.length === 0) {
        return [];
      }
      const bufferedTexts = [...pending.bufferedTexts];
      pending.bufferedTexts.length = 0;
      return bufferedTexts;
    },

    finishRun(chatId) {
      const pending = pendingRuns.get(chatId);
      if (!pending) {
        return null;
      }

      const nextTurn = pending.queuedTurns.at(-1) ?? null;
      if (!nextTurn) {
        clearLiveInputRetry(pending);
        pendingRuns.delete(chatId);
        return null;
      }

      clearLiveInputRetry(pending);
      pendingRuns.delete(chatId);
      return nextTurn;
    },
  };
}
