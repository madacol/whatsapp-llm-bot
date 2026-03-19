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
 *   beginRun: (input: { chatId: string, userText: string, harness: AgentHarness }) => HarnessRunDecision,
 *   markRunActive: (chatId: string) => void,
 *   consumeBufferedTexts: (chatId: string) => string[],
 *   finishRun: (chatId: string) => void,
 * }}
 */
export function createHarnessRunCoordinator() {
  /** @type {Map<string, { bufferedTexts: string[], isActive: boolean }>} */
  const pendingRuns = new Map();

  return {
    beginRun({ chatId, userText, harness }) {
      if (userText) {
        const pending = pendingRuns.get(chatId);
        if (pending) {
          if (pending.isActive && harness.injectMessage?.(chatId, userText)) {
            return { status: "injected" };
          }
          pending.bufferedTexts.push(userText);
          return { status: "buffered" };
        }
      }

      pendingRuns.set(chatId, { bufferedTexts: [], isActive: false });
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
      pendingRuns.delete(chatId);
    },
  };
}
