import { createLogger } from "./logger.js";

const log = createLogger("restart");

/**
 * @typedef {{
 *   isWaiting: () => boolean,
 *   beginWaiting: () => void,
 *   queueTurn: (turn: ChatTurn) => void,
 *   drainQueuedTurns: () => ChatTurn[],
 *   reset: () => void,
 * }} RestartGate
 */

/**
 * In-memory process-local gate used once a restart is waiting for active turns.
 * Queued turns are intentionally not processed in the old process; normal
 * production restarts replace the process after the active turns drain.
 * @returns {RestartGate}
 */
export function createRestartGate() {
  let waiting = false;
  /** @type {ChatTurn[]} */
  const queuedTurns = [];

  return {
    isWaiting() {
      return waiting;
    },
    beginWaiting() {
      waiting = true;
      log.info("Restart gate entered waiting state.");
    },
    queueTurn(turn) {
      queuedTurns.push(turn);
      log.info("Queued incoming turn while restart is waiting.", {
        chatId: turn.chatId,
        queuedTurnCount: queuedTurns.length,
      });
    },
    drainQueuedTurns() {
      const turns = [...queuedTurns];
      queuedTurns.length = 0;
      log.info("Drained turns queued while restart was waiting.", {
        queuedTurnCount: turns.length,
      });
      return turns;
    },
    reset() {
      waiting = false;
      queuedTurns.length = 0;
      log.info("Restart gate reset.");
    },
  };
}

export const defaultRestartGate = createRestartGate();
