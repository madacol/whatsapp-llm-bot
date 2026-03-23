import { createNativeHarness } from "./native.js";
import { createCodexHarness } from "./codex.js";

/** @type {Map<string, () => AgentHarness>} */
const registry = new Map();

/** @type {Map<string, AgentHarness>} Singleton cache for stateful harnesses */
const instances = new Map();

// Register the native harness by default
registry.set("native", createNativeHarness);
registry.set("codex", createCodexHarness);

/** @type {HarnessCapabilities} */
const DEFAULT_HARNESS_CAPABILITIES = {
  supportsResume: false,
  supportsCancel: false,
  supportsLiveInput: false,
  supportsApprovals: false,
  supportsWorkdir: false,
  supportsSandboxConfig: false,
  supportsModelSelection: false,
  supportsReasoningEffort: false,
  supportsSessionFork: false,
};

/**
 * @param {AgentHarness | null | undefined} harness
 * @returns {harness is AgentHarness & { processLlmResponse: (params: AgentHarnessParams) => Promise<AgentResult> }}
 */
function hasLegacyRun(harness) {
  return !!harness
    && typeof harness === "object"
    && "processLlmResponse" in harness
    && typeof harness.processLlmResponse === "function";
}

/**
 * Normalize a harness to the unified contract so callers don't need to carry
 * compatibility branches.
 * @param {string} name
 * @param {AgentHarness} harness
 * @returns {AgentHarness}
 */
function normalizeHarness(name, harness) {
  const getName = harness.getName ?? (() => name);
  const getCapabilities = harness.getCapabilities ?? (() => DEFAULT_HARNESS_CAPABILITIES);
  const handleCommand = harness.handleCommand ?? (async () => false);
  const run = harness.run ?? (
    hasLegacyRun(harness)
      ? harness.processLlmResponse.bind(harness)
      : async () => {
          throw new Error(`Harness "${name}" does not implement run()`);
        }
  );

  return {
    ...harness,
    getName,
    getCapabilities,
    handleCommand,
    run,
  };
}

/**
 * Register a harness factory under a name.
 * @param {string} name
 * @param {() => AgentHarness} factory
 */
export function registerHarness(name, factory) {
  registry.set(name, factory);
  instances.delete(name);
}

/**
 * Resolve a harness by name. Falls back to native if not found.
 * Returns a cached singleton so stateful harnesses preserve their per-chat active state.
 * @param {string} [name]
 * @returns {AgentHarness}
 */
export function resolveHarness(name) {
  const key = name ?? "native";
  const cached = instances.get(key);
  if (cached) return cached;

  const factory = registry.get(key);
  const harness = normalizeHarness(key, factory ? factory() : createNativeHarness());
  instances.set(key, harness);
  return harness;
}

/**
 * List registered harness names.
 * @returns {string[]}
 */
export function listHarnesses() {
  return [...registry.keys()];
}

/**
 * Determine the harness name from a persona/agent and chat config.
 * @param {AgentDefinition | null | undefined} persona
 * @param {{ harness?: string | null } | null | undefined} chatInfo
 * @returns {string}
 */
export function resolveHarnessName(persona, chatInfo) {
  return persona?.harness ?? chatInfo?.harness ?? "native";
}

/**
 * Wait for all active harnesses to become idle. Used for graceful shutdown.
 * @returns {Promise<string[]>}
 */
export async function waitForAllHarnesses() {
  const results = await Promise.all(
    [...instances.values()]
      .filter((h) => typeof h.waitForIdle === "function")
      .map((h) => /** @type {() => Promise<string[]>} */ (h.waitForIdle)()),
  );
  return results.flat();
}
