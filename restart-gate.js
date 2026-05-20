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
    },
    queueTurn(turn) {
      queuedTurns.push(turn);
    },
    drainQueuedTurns() {
      const turns = [...queuedTurns];
      queuedTurns.length = 0;
      return turns;
    },
    reset() {
      waiting = false;
      queuedTurns.length = 0;
    },
  };
}

export const defaultRestartGate = createRestartGate();
