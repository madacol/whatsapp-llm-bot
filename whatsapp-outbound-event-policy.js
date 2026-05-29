const DEFAULT_PERSIST_DELAY_MS = 1500;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isIgnoredRuntimeStatePath(filePath) {
  const normalized = normalizePath(filePath);
  return normalized.includes("/auth_info_baileys/")
    || normalized.startsWith("auth_info_baileys/")
    || normalized.includes("/pgdata/")
    || normalized.startsWith("pgdata/")
    || normalized.includes("/.media/")
    || normalized.startsWith(".media/")
    || normalized.endsWith("/data/models.json")
    || normalized === "data/models.json";
}

/**
 * @param {OutboundEvent} event
 * @returns {boolean}
 */
export function isIgnoredRuntimeStateFileChange(event) {
  return event.kind === "file_change" && isIgnoredRuntimeStatePath(event.path);
}

/**
 * @param {OutboundEvent} event
 * @returns {OutboundEvent | null}
 */
export function toReplayableOutboundEvent(event) {
  if (isIgnoredRuntimeStateFileChange(event)) {
    return null;
  }
  return event;
}

/**
 * @param {unknown} event
 * @returns {string | null}
 */
export function classifyUnreplayableOutboundEvent(event) {
  if (!isRecord(event)) {
    return "event is not an object";
  }
  if (event.kind === "file_change" && typeof event.path === "string" && isIgnoredRuntimeStatePath(event.path)) {
    return "ignored runtime-state file change";
  }
  return null;
}

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
 * @param {{ kind: "text" } | { kind: "event", event: OutboundEvent }} payload
 * @returns {number}
 */
export function getOutboundQueuePriority(payload) {
  if (payload.kind === "text") {
    return 0;
  }
  const event = payload.event;
  if (event.kind === "content") {
    if (event.source === "tool-result" || event.source === "error" || event.source === "warning") {
      return 0;
    }
    if (event.source === "llm") {
      return 1;
    }
    return 2;
  }
  if (event.kind === "usage") {
    return 2;
  }
  return 3;
}
