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
 *   updatedAt?: string,
 * }} HarnessSessionBinding
 */

/**
 * @param {HarnessSessionBinding} binding
 * @returns {HarnessSessionBinding}
 */
function normalizeBinding(binding) {
  return {
    ...binding,
    runtimePayload: binding.runtimePayload ?? null,
    updatedAt: binding.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * @returns {{
 *   upsert: (binding: HarnessSessionBinding) => HarnessSessionBinding,
 *   getBinding: (chatId: string) => HarnessSessionBinding | null,
 *   getHarness: (chatId: string) => string | null,
 *   resolveRoutableSession: (chatId: string) => HarnessSessionBinding | null,
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
