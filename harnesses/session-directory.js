/**
 * In-process directory for routable harness session bindings.
 *
 * Chat config remains the durable source of truth for current session ids.
 * This directory centralizes the runtime binding shape so routing, recovery,
 * and provider-instance compatibility can evolve behind one seam instead of
 * being inferred ad hoc from individual harnesses.
 */

/**
 * @typedef {"starting" | "ready" | "running" | "stopped" | "error"} HarnessSessionStatus
 */

/**
 * @typedef {{
 *   chatId: string,
 *   harnessName: string,
 *   instanceId: string,
 *   status: HarnessSessionStatus,
 *   resumeCursor?: string | null,
 *   runtimeMode?: string | null,
 *   runtimePayload?: Record<string, unknown> | null,
 *   activeTurnId?: string | null,
 *   lastRuntimeEvent?: string | null,
 *   lastRuntimeEventAt?: string | null,
 *   updatedAt?: string,
 * }} HarnessSessionBinding
 *
 * @typedef {{
 *   chatId: string,
 *   harnessName: string,
 *   instanceId: string,
 *   resumeCursor: string | null,
 *   runtimeMode: string | null,
 *   workdir: string | null,
 *   model: string | null,
 *   activeTurnId: string | null,
 *   lastRuntimeEvent: string | null,
 *   lastRuntimeEventAt: string | null,
 * }} HarnessSessionRecoveryState
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * @param {HarnessSessionBinding} binding
 * @returns {HarnessSessionBinding}
 */
function normalizeBinding(binding) {
  const runtimePayload = binding.runtimePayload ?? null;
  const activeTurnId = binding.activeTurnId ?? (isRecord(runtimePayload) ? stringOrNull(runtimePayload.activeTurnId) : null);
  const lastRuntimeEvent = binding.lastRuntimeEvent ?? (isRecord(runtimePayload) ? stringOrNull(runtimePayload.lastRuntimeEvent) : null);
  const lastRuntimeEventAt = binding.lastRuntimeEventAt ?? (isRecord(runtimePayload) ? stringOrNull(runtimePayload.lastRuntimeEventAt) : null);
  return {
    ...binding,
    runtimePayload,
    activeTurnId,
    lastRuntimeEvent,
    lastRuntimeEventAt,
    updatedAt: binding.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * @param {HarnessSessionBinding} binding
 * @returns {HarnessSessionRecoveryState}
 */
function toRecoveryState(binding) {
  const runtimePayload = binding.runtimePayload ?? null;
  return {
    chatId: binding.chatId,
    harnessName: binding.harnessName,
    instanceId: binding.instanceId,
    resumeCursor: binding.resumeCursor ?? null,
    runtimeMode: binding.runtimeMode ?? null,
    workdir: isRecord(runtimePayload) ? stringOrNull(runtimePayload.workdir) : null,
    model: isRecord(runtimePayload) ? stringOrNull(runtimePayload.model) : null,
    activeTurnId: binding.activeTurnId ?? null,
    lastRuntimeEvent: binding.lastRuntimeEvent ?? null,
    lastRuntimeEventAt: binding.lastRuntimeEventAt ?? null,
  };
}

/**
 * @returns {{
 *   upsert: (binding: HarnessSessionBinding) => HarnessSessionBinding,
 *   getBinding: (chatId: string) => HarnessSessionBinding | null,
 *   getHarness: (chatId: string) => string | null,
 *   resolveRoutableSession: (chatId: string) => HarnessSessionBinding | null,
 *   resolveRecoveryState: (chatId: string) => HarnessSessionRecoveryState | null,
 *   listBindings: () => HarnessSessionBinding[],
 *   remove: (chatId: string) => void,
 *   clear: () => void,
 * }}
 */
export function createHarnessSessionDirectory() {
  /** @type {Map<string, HarnessSessionBinding>} */
  const bindings = new Map();

  return {
    upsert(binding) {
      const normalized = normalizeBinding(binding);
      bindings.set(normalized.chatId, normalized);
      return normalized;
    },
    getBinding(chatId) {
      return bindings.get(chatId) ?? null;
    },
    getHarness(chatId) {
      return bindings.get(chatId)?.harnessName ?? null;
    },
    resolveRoutableSession(chatId) {
      return bindings.get(chatId) ?? null;
    },
    resolveRecoveryState(chatId) {
      const binding = bindings.get(chatId);
      return binding ? toRecoveryState(binding) : null;
    },
    listBindings() {
      return [...bindings.values()];
    },
    remove(chatId) {
      bindings.delete(chatId);
    },
    clear() {
      bindings.clear();
    },
  };
}

const globalHarnessSessionDirectory = createHarnessSessionDirectory();

/**
 * @returns {ReturnType<typeof createHarnessSessionDirectory>}
 */
export function getHarnessSessionDirectory() {
  return globalHarnessSessionDirectory;
}
