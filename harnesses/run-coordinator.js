/**
 * @typedef {{
 *   status: "started" | "buffered" | "injected";
 * }} HarnessRunDecision
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
 *   beginRun: (input: { turn: ChatTurn, userText: string, harness: AgentHarness }) => HarnessRunDecision,
 *   markRunActive: (chatId: string) => void,
 *   consumeBufferedTexts: (chatId: string) => string[],
 *   finishRun: (chatId: string) => ChatTurn | null,
 * }}
 */
export function createHarnessRunCoordinator() {
  /** @type {Map<string, { bufferedTexts: string[], queuedTurns: ChatTurn[], isActive: boolean }>} */
  const pendingRuns = new Map();

  return {
    beginRun({ turn, userText, harness }) {
      const { chatId } = turn;
      const pending = pendingRuns.get(chatId);
      if (pending) {
        if (pending.isActive && userText && harness.injectMessage?.(chatId, userText)) {
          return { status: "injected" };
        }
        if (pending.isActive) {
          pending.queuedTurns.push(turn);
          return { status: "buffered" };
        }
        if (userText) {
          pending.bufferedTexts.push(userText);
        } else {
          pending.queuedTurns.push(turn);
        }
        return { status: "buffered" };
      }

      pendingRuns.set(chatId, { bufferedTexts: [], queuedTurns: [], isActive: false });
      return { status: "started" };
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
        pendingRuns.delete(chatId);
        return null;
      }

      pendingRuns.delete(chatId);
      return nextTurn;
    },
  };
}
