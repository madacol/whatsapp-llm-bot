const RESTART_DELAY_MS = 750;

/**
 * @typedef {{ unref: () => void }} RestartTimer
 * @typedef {(pid: number, signal: NodeJS.Signals) => void} RestartKillFn
 * @typedef {(callback: () => void, delayMs: number) => RestartTimer} RestartSetTimeoutFn
 */

/**
 * Schedule a restart after the current response has had time to reach the
 * transport runtime.
 * @param {{
 *   pid?: number,
 *   delayMs?: number,
 *   killFn?: RestartKillFn,
 *   setTimeoutFn?: RestartSetTimeoutFn,
 * }} [options]
 * @returns {void}
 */
export function scheduleRestart(options = {}) {
  const {
    pid = process.pid,
    delayMs = RESTART_DELAY_MS,
    killFn = process.kill,
    setTimeoutFn = setTimeout,
  } = options;

  const timer = setTimeoutFn(() => {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid restart PID: ${pid}`);
    }
    killFn(pid, "SIGTERM");
  }, Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : RESTART_DELAY_MS);
  timer.unref();
}
