/**
 * Harness registry — resolves harness names to AgentHarness instances.
 */

import { createNativeHarness } from "./native.js";

/** @type {Map<string, () => AgentHarness>} */
const registry = new Map();

/** @type {Map<string, AgentHarness>} Singleton cache for stateful harnesses */
const instances = new Map();

// Register the native harness by default
registry.set("native", createNativeHarness);

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
  const harness = factory ? factory() : createNativeHarness();
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

// Re-export commonly used constants from native harness
export { NO_OP_HOOKS, MAX_TOOL_CALL_DEPTH, parseToolArgs } from "./native.js";
