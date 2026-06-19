const DEFAULT_ACTIVE_TURN_TIMEOUT_MS = 125_000;
const DEFAULT_FORCE_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * @typedef {ReturnType<typeof setTimeout> | { unref?: () => void }} ShutdownTimer
 * @typedef {(callback: () => void, delayMs: number) => ShutdownTimer} ShutdownSetTimeoutFn
 * @typedef {(timer: ShutdownTimer) => void} ShutdownClearTimeoutFn
 * @typedef {(code?: number) => never | void} ShutdownExitFn
 * @typedef {{ info: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} ShutdownLogger
 */

/**
 * Wait for a promise with a timeout. The timeout resolves with the fallback
 * value so SIGTERM can continue cleanup after a bounded graceful turn drain.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {{
 *   timeoutMs: number,
 *   timeoutValue: T,
 *   setTimeoutFn: ShutdownSetTimeoutFn,
 *   clearTimeoutFn: ShutdownClearTimeoutFn,
 * }} options
 * @returns {Promise<{ timedOut: boolean, value: T }>}
 */
async function withTimeout(promise, options) {
  const { timeoutMs, timeoutValue, setTimeoutFn, clearTimeoutFn } = options;
  /** @type {ShutdownTimer | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => {
      resolve({ timedOut: true, value: timeoutValue });
    }, timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]);
  if (timer) {
    clearTimeoutFn(timer);
  }
  return /** @type {{ timedOut: boolean, value: T }} */ (result);
}

/**
 * Create the SIGINT/SIGTERM shutdown sequence. Active agent turns get their own
 * drain window before resource cleanup starts; the shorter force-exit timer is
 * reserved for cleanup hangs after active work has drained or timed out.
 *
 * @param {{
 *   waitForActiveTurns: () => Promise<string[]>,
 *   cleanupResources: () => Promise<void>,
 *   log: ShutdownLogger,
 *   forceCleanupTimeoutMs?: number,
 *   activeTurnTimeoutMs?: number,
 *   setTimeoutFn?: ShutdownSetTimeoutFn,
 *   clearTimeoutFn?: ShutdownClearTimeoutFn,
 *   exitFn?: ShutdownExitFn,
 * }} options
 * @returns {(signal: "SIGINT" | "SIGTERM") => Promise<void>}
 */
export function createGracefulShutdownHandler(options) {
  const {
    waitForActiveTurns,
    cleanupResources,
    log,
    forceCleanupTimeoutMs = DEFAULT_FORCE_CLEANUP_TIMEOUT_MS,
    activeTurnTimeoutMs = DEFAULT_ACTIVE_TURN_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = (timer) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer)),
    exitFn = process.exit,
  } = options;
  let shutdownStarted = false;

  return async function shutdown(signal) {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    const exitCode = signal === "SIGINT" ? 130 : 0;

    log.info(`${signal} received, waiting for active turns before cleanup...`);
    const activeDrain = await withTimeout(waitForActiveTurns(), {
      timeoutMs: activeTurnTimeoutMs,
      timeoutValue: [],
      setTimeoutFn,
      clearTimeoutFn,
    });
    if (activeDrain.timedOut) {
      log.error(`${signal} active turn drain timed out after ${activeTurnTimeoutMs}ms; continuing cleanup.`);
    } else if (activeDrain.value.length > 0) {
      log.info(`Shutdown waited on ${activeDrain.value.length} chat(s): ${activeDrain.value.join(", ")}`);
    }

    let forceExitRequested = false;
    const forceExitTimer = setTimeoutFn(() => {
      forceExitRequested = true;
      log.error(`${signal} cleanup timed out after ${forceCleanupTimeoutMs}ms; exiting anyway.`);
      exitFn(exitCode);
    }, forceCleanupTimeoutMs);
    forceExitTimer.unref?.();

    await cleanupResources();
    clearTimeoutFn(forceExitTimer);
    if (!forceExitRequested) {
      exitFn(exitCode);
    }
  };
}
