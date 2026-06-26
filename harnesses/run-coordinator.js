/**
 * @typedef {{
 *   supportsLiveInput: boolean;
 *   injectMessage?: AgentHarness["injectMessage"];
 * }} LiveInputTarget
 */

/**
 * @typedef {{
 *   status: "started" | "buffered" | "injected";
 *   reason?: "pending-setup" | "active-run" | "live-input-retry";
 * }} HarnessRunDecision
 */

/**
 * @typedef {{
 *   chatId: string;
 *   text: string;
 *   target: LiveInputTarget;
 *   turn: ChannelInput;
 *   journalId: number | null;
 * }} PendingLiveInput
 */

/**
 * @typedef {{
 *   bufferedTexts: string[];
 *   queuedTurns: ChannelInput[];
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
 *   liveInputJournal?: {
 *     enqueue: (input: { chatId: string, turnId: string, text: string }) => Promise<{ id: number }>,
 *     markAccepted: (id: number) => Promise<void>,
 *   },
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
 *   beginRun: (input: { turn: ChannelInput, userText: string, liveInputTarget?: LiveInputTarget | null, ownerKey?: string | null }) => Promise<HarnessRunDecision>,
 *   hasPendingRun: (chatId: string) => boolean,
 *   markRunActive: (chatId: string) => void,
 *   consumeBufferedTexts: (chatId: string) => string[],
 *   preparePendingLiveInputReplay: (chatId: string, turn: ChannelInput) => { turn: ChannelInput, text: string } | null,
 *   finishRun: (chatId: string) => ChannelInput | null,
 * }}
 * @param {HarnessRunCoordinatorOptions} [options]
 */
export function createHarnessRunCoordinator(options = {}) {
  const liveInputRetryDelayMs = options.liveInputRetryDelayMs ?? 50;
  const liveInputJournal = options.liveInputJournal ?? null;
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
   * @param {{ chatId: string, text: string, turn: ChannelInput, target: LiveInputTarget & { injectMessage: NonNullable<LiveInputTarget["injectMessage"]> }, journalId?: number | null }} input
   * @returns {Promise<{ accepted: boolean, journalId: number | null }>}
   */
  async function tryInjectLiveInput(input) {
    const { chatId, text, target, turn } = input;
    let journalId = input.journalId ?? null;
    if (liveInputJournal && journalId === null) {
      try {
        const row = await liveInputJournal.enqueue({
          chatId,
          turnId: getLiveInputTurnId(turn),
          text,
        });
        journalId = row.id;
      } catch {
        return { accepted: false, journalId };
      }
    }
    try {
      const accepted = !!(await target.injectMessage(chatId, text));
      if (accepted && liveInputJournal && journalId !== null) {
        try {
          await liveInputJournal.markAccepted(journalId);
        } catch {
          // The sidecar accepted the input. Leaving the durable row behind is
          // safer than reporting a failed injection and sending it twice.
        }
      }
      return { accepted, journalId };
    } catch {
      return { accepted: false, journalId };
    }
  }

  /**
   * @param {ChannelInput} turn
   * @returns {string}
   */
  function getLiveInputTurnId(turn) {
    if ("id" in turn && typeof turn.id === "string" && turn.id) {
      return turn.id;
    }
    return turn.chatId;
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {LiveInputTarget & { injectMessage: NonNullable<LiveInputTarget["injectMessage"]> }} target
   * @param {ChannelInput} turn
   * @param {number | null} [journalId]
   * @returns {Promise<{ accepted: boolean, journalId: number | null }>}
   */
  async function tryInjectLiveInputForTurn(chatId, text, target, turn, journalId = null) {
    return tryInjectLiveInput({ chatId, text, target, turn, journalId });
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
      const injected = await tryInjectLiveInputForTurn(
        liveInput.chatId,
        liveInput.text,
        liveInput.target,
        liveInput.turn,
        liveInput.journalId,
      );
      if (!injected.accepted) {
        liveInput.journalId = injected.journalId;
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
   * @param {ChannelInput} turn
   * @param {LiveInputTarget} target
   * @param {number | null} [journalId]
   * @returns {void}
   */
  function queueLiveInputRetry(chatId, pending, text, turn, target, journalId = null) {
    pending.pendingLiveInputs.push({ chatId, text, target, turn, journalId });
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
          const injected = await tryInjectLiveInputForTurn(chatId, userText, pending.liveInputTarget, turn);
          if (injected.accepted) {
            return { status: "injected" };
          }
          queueLiveInputRetry(chatId, pending, userText, turn, pending.liveInputTarget, injected.journalId);
          return { status: "buffered", reason: "live-input-retry" };
        }
        if (pending.isActive) {
          pending.queuedTurns.push(turn);
          return { status: "buffered", reason: "active-run" };
        }
        if (sameOwner && userText) {
          pending.bufferedTexts.push(userText);
        } else {
          pending.queuedTurns.push(turn);
        }
        return { status: "buffered", reason: "pending-setup" };
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

    preparePendingLiveInputReplay(chatId, turn) {
      const pending = pendingRuns.get(chatId);
      if (!pending) {
        return null;
      }
      const pendingInput = pending.pendingLiveInputs.find((liveInput) => liveInput.turn === turn);
      if (!pendingInput) {
        return null;
      }

      const latestInput = pending.pendingLiveInputs.at(-1) ?? pendingInput;
      if (pending.liveInputRetryTimer) {
        clearTimeout(pending.liveInputRetryTimer);
        pending.liveInputRetryTimer = null;
      }
      pending.pendingLiveInputs.length = 0;
      pending.pendingLiveInputs.push(latestInput);
      return { turn: latestInput.turn, text: latestInput.text };
    },

    finishRun(chatId) {
      const pending = pendingRuns.get(chatId);
      if (!pending) {
        return null;
      }

      const queuedTurn = pending.queuedTurns.at(-1) ?? null;
      const pendingLiveInput = pending.pendingLiveInputs.at(-1) ?? null;
      const nextTurn = queuedTurn
        ?? (pendingLiveInput
          ? { ...pendingLiveInput.turn, content: [{ type: "text", text: pendingLiveInput.text }] }
          : null);
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
