/**
 * @typedef {{
 *   supportsLiveInput: boolean;
 *   injectMessage?: AgentHarness["injectMessage"];
 * }} LiveInputTarget
 */

/**
 * @typedef {{
 *   status: "started" | "buffered" | "injected";
 * }} HarnessRunDecision
 */

/**
 * @typedef {{
 *   chatId: string;
 *   text: string;
 *   target: LiveInputTarget;
 *   turn: ChatTurn;
 * }} PendingLiveInput
 */

/**
 * @typedef {{
 *   bufferedTexts: string[];
 *   queuedTurns: ChatTurn[];
 *   pendingLiveInputs: PendingLiveInput[];
 *   liveInputRetryTimer: ReturnType<typeof setTimeout> | null;
 *   isActive: boolean;
 *   liveInputTarget: LiveInputTarget;
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
 *   beginRun: (input: { turn: ChatTurn, userText: string, liveInputTarget?: LiveInputTarget | null, ownerKey?: string | null }) => Promise<HarnessRunDecision>,
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
   * @param {LiveInputTarget} target
   * @returns {target is LiveInputTarget & { injectMessage: NonNullable<LiveInputTarget["injectMessage"]> }}
   */
  function canInjectLiveInput(target) {
    return target.supportsLiveInput && typeof target.injectMessage === "function";
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {LiveInputTarget & { injectMessage: NonNullable<LiveInputTarget["injectMessage"]> }} target
   * @returns {Promise<boolean>}
   */
  async function tryInjectLiveInput(chatId, text, target) {
    try {
      return !!(await target.injectMessage(chatId, text));
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
      if (!canInjectLiveInput(liveInput.target)) {
        remaining.push(liveInput);
        continue;
      }
      const injected = await tryInjectLiveInput(liveInput.chatId, liveInput.text, liveInput.target);
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
   * @param {ChatTurn} turn
   * @param {LiveInputTarget} target
   * @returns {void}
   */
  function queueLiveInputRetry(chatId, pending, text, turn, target) {
    pending.pendingLiveInputs.push({ chatId, text, target, turn });
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
    async beginRun({ turn, userText, liveInputTarget, ownerKey = null }) {
      const { chatId } = turn;
      const pending = pendingRuns.get(chatId);
      if (pending) {
        const sameOwner = !ownerKey || !pending.ownerKey || ownerKey === pending.ownerKey;
        if (pending.isActive && userText && canInjectLiveInput(pending.liveInputTarget)) {
          if (await tryInjectLiveInput(chatId, userText, pending.liveInputTarget)) {
            return { status: "injected" };
          }
          queueLiveInputRetry(chatId, pending, userText, turn, pending.liveInputTarget);
          return { status: "buffered" };
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

      if (!liveInputTarget) {
        throw new Error("Live input target is required to start a run.");
      }
      pendingRuns.set(chatId, {
        bufferedTexts: [],
        queuedTurns: [],
        pendingLiveInputs: [],
        liveInputRetryTimer: null,
        isActive: false,
        liveInputTarget,
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

      const nextTurn = pending.queuedTurns.at(-1)
        ?? pending.pendingLiveInputs.at(-1)?.turn
        ?? null;
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
