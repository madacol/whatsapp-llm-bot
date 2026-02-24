/**
 * Create a polling daemon that runs an optional init task then polls on an interval.
 *
 * @param {{
 *   init?: () => Promise<void>,
 *   poll: () => Promise<void>,
 *   intervalMs: number,
 *   label: string,
 * }} options
 * @returns {() => void} Stop function to clear the interval
 */
export function createDaemon({ init, poll, intervalMs, label }) {
  if (init) {
    init().catch((err) => console.error(`${label} init error:`, err));
  }

  const interval = setInterval(async () => {
    try {
      await poll();
    } catch (error) {
      console.error(`${label} poll error:`, error);
    }
  }, intervalMs);

  return () => clearInterval(interval);
}
