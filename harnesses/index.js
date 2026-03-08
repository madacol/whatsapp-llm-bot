/**
 * Harness registry — resolves harness names to AgentHarness instances.
 */

import { createNativeHarness } from "./native.js";

/** @type {Map<string, () => AgentHarness>} */
const registry = new Map();

// Register the native harness by default
registry.set("native", createNativeHarness);

/**
 * Register a harness factory under a name.
 * @param {string} name
 * @param {() => AgentHarness} factory
 */
export function registerHarness(name, factory) {
  registry.set(name, factory);
}

/**
 * Resolve a harness by name. Falls back to native if not found.
 * @param {string} [name]
 * @returns {AgentHarness}
 */
export function resolveHarness(name) {
  const factory = registry.get(name ?? "native");
  if (!factory) {
    return createNativeHarness();
  }
  return factory();
}

/**
 * List registered harness names.
 * @returns {string[]}
 */
export function listHarnesses() {
  return [...registry.keys()];
}

// Re-export commonly used constants from native harness
export { NO_OP_HOOKS, MAX_TOOL_CALL_DEPTH, parseToolArgs } from "./native.js";
