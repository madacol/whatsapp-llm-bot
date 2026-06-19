import { createLogger } from "../logger.js";

const RESTART_DELAY_MS = 750;
const log = createLogger("restart");

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
 *   restartId?: string,
 *   log?: Pick<ReturnType<typeof createLogger>, "info" | "error">,
 * }} [options]
 * @returns {void}
 */
export function scheduleRestart(options = {}) {
  const {
    pid = process.pid,
    delayMs = RESTART_DELAY_MS,
    killFn = process.kill,
    setTimeoutFn = setTimeout,
    restartId,
    log: restartLog = log,
  } = options;
  const resolvedDelayMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : RESTART_DELAY_MS;

  restartLog.info("Restart signal scheduled.", {
    restartId: restartId ?? null,
    pid,
    delayMs: resolvedDelayMs,
  });

  const timer = setTimeoutFn(() => {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid restart PID: ${pid}`);
    }
    restartLog.info("Restart SIGTERM sending.", {
      restartId: restartId ?? null,
      pid,
      signal: "SIGTERM",
    });
    try {
      killFn(pid, "SIGTERM");
      restartLog.info("Restart SIGTERM sent.", {
        restartId: restartId ?? null,
        pid,
        signal: "SIGTERM",
      });
    } catch (error) {
      restartLog.error("Restart SIGTERM failed.", {
        restartId: restartId ?? null,
        pid,
        signal: "SIGTERM",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, resolvedDelayMs);
  timer.unref();
}
