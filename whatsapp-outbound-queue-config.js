const DEFAULT_PERSIST_DELAY_MS = 1500;
const DEFAULT_REPLAY_DELAY_MS = 1000;

/**
 * @returns {number}
 */
export function getOutboundQueuePersistDelayMs() {
  const raw = process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
  if (raw === undefined || raw.trim() === "") {
    if (process.env.TESTING === "1") {
      return 0;
    }
    return DEFAULT_PERSIST_DELAY_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PERSIST_DELAY_MS;
}

/**
 * @returns {number}
 */
export function getOutboundQueueReplayDelayMs() {
  const raw = process.env.MADABOT_OUTBOUND_QUEUE_REPLAY_DELAY_MS;
  if (raw === undefined || raw.trim() === "") {
    if (process.env.TESTING === "1") {
      return 0;
    }
    return DEFAULT_REPLAY_DELAY_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REPLAY_DELAY_MS;
}
