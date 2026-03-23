/**
 * Harness registry — resolves harness names to AgentHarness instances.
 */

import { createNativeHarness } from "./native.js";
import { createCodexHarness } from "./codex.js";
import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import { confirmSandboxEscape } from "./sandbox-approval-coordinator.js";
import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";

const log = createLogger("harnesses");

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
 * Returns a cached singleton so stateful harnesses (e.g. claude-agent-sdk)
 * preserve their per-chat active query state across calls.
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
 * @returns {Promise<string[]>} chat IDs that were waited on
 */
export async function waitForAllHarnesses() {
  const results = await Promise.all(
    [...instances.values()]
      .filter(h => typeof h.waitForIdle === "function")
      .map(h => /** @type {() => Promise<string[]>} */ (h.waitForIdle)())
  );
  return results.flat();
}

/**
 * Register optional harness implementations that may not be installed in every environment.
 * Missing optional dependencies are ignored quietly; other failures are logged.
 * @returns {Promise<void>}
 */
export async function registerOptionalHarnesses() {
  try {
    const { createClaudeAgentSdkHarness } = await import("./claude-agent-sdk.js");
    registerHarness("claude-agent-sdk", createClaudeAgentSdkHarness);
  } catch (error) {
    const message = errorToString(error);
    if (message.includes("Cannot find") || message.includes("MODULE_NOT_FOUND")) {
      log.debug("Claude Agent SDK not installed, skipping harness registration");
      return;
    }
    log.warn("Failed to load Claude Agent SDK harness:", message);
  }
}

/**
 * Confirm a harness-style sandbox escape request when one is required.
 * Returns `true` when no sandbox escape is needed or the user allows it.
 * @param {{
 *   toolName: string,
 *   input: Record<string, unknown>,
 *   confirm: (message: string) => Promise<boolean>,
 *   workdir?: string | null,
 *   sandboxMode?: HarnessRunConfig["sandboxMode"] | null,
 *   additionalWritableRoots?: string[] | null,
 * }} input
 * @returns {Promise<boolean>}
 */
export async function confirmHarnessSandboxEscape(input) {
  const request = getSandboxEscapeRequest(input.toolName, input.input, {
    workdir: input.workdir ?? null,
    sandboxMode: input.sandboxMode ?? null,
    additionalWritableRoots: input.additionalWritableRoots ?? null,
  });
  if (!request) {
    return true;
  }
  return confirmSandboxEscape(request, input.confirm);
}

// Re-export commonly used constants from native harness
export { NO_OP_HOOKS, MAX_TOOL_CALL_DEPTH, parseToolArgs } from "./native.js";
export { createHarnessRunCoordinator } from "./run-coordinator.js";
