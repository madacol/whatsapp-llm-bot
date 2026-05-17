import { createNativeHarness } from "./native.js";
import { createCodexHarness } from "./codex.js";
import { createPiHarness } from "./pi.js";
import { createHarnessAdapterFromHarness } from "./adapter.js";

/**
 * @typedef {{
 *   name: string,
 *   instanceId: string,
 *   config: Record<string, unknown>,
 * }} HarnessDriverCreateInput
 */

/**
 * @typedef {() => AgentHarness} HarnessDriverFactory
 */

/**
 * @typedef {(input: HarnessDriverCreateInput) => AgentHarness} HarnessInstanceFactory
 */

/**
 * @typedef {HarnessCapabilities & {
 *   sessionModelSwitch: "in-session" | "unsupported",
 *   supportsRollback: boolean,
 *   supportsUserInputRequests: boolean,
 * }} NormalizedHarnessCapabilities
 */

/**
 * @typedef {{
 *   name: string,
 *   instanceId: string,
 *   displayName: string,
 *   supportsInstances: boolean,
 *   continuationKey: string,
 *   capabilities: NormalizedHarnessCapabilities,
 *   harness: AgentHarness,
 *   adapter: ReturnType<typeof createHarnessAdapterFromHarness>,
 * }} HarnessInstance
 */

/** @type {Map<string, HarnessDriverFactory>} */
const registry = new Map();

/**
 * @typedef {"available" | "unavailable" | "unknown" | "maintenance"} HarnessDriverAvailability
 */

/**
 * @typedef {{
 *   availability: HarnessDriverAvailability,
 *   message?: string,
 *   checkedAt?: string,
 * }} HarnessDriverStatus
 */

/**
 * @typedef {{
 *   displayName?: string,
 *   supportsInstances?: boolean,
 *   docsUrl?: string,
 *   statusUrl?: string,
 *   createInstance?: HarnessInstanceFactory,
 *   getStatus?: () => Promise<HarnessDriverStatus> | HarnessDriverStatus,
 * }} HarnessDriverOptions
 */

/**
 * @typedef {{
 *   name: string,
 *   displayName: string,
 *   supportsInstances: boolean,
 *   docsUrl?: string,
 *   statusUrl?: string,
 * }} HarnessDriverDescriptor
 */

/** @type {Map<string, HarnessDriverOptions>} */
const driverOptions = new Map();

/** @type {Map<string, HarnessInstance>} Singleton cache for stateful harness instances */
const instances = new Map();

/**
 * @param {string} name
 * @param {HarnessDriverOptions} [options]
 * @returns {Required<Pick<HarnessDriverOptions, "displayName" | "supportsInstances">> & HarnessDriverOptions}
 */
function normalizeDriverOptions(name, options = {}) {
  return {
    ...options,
    displayName: options.displayName ?? name,
    supportsInstances: options.supportsInstances ?? false,
  };
}

/**
 * @returns {string}
 */
function getCheckedAt() {
  return new Date().toISOString();
}

/**
 * @param {string} name
 * @returns {HarnessDriverDescriptor}
 */
function getDriverDescriptor(name) {
  const options = normalizeDriverOptions(name, driverOptions.get(name));
  return {
    name,
    displayName: options.displayName,
    supportsInstances: options.supportsInstances,
    ...(options.docsUrl ? { docsUrl: options.docsUrl } : {}),
    ...(options.statusUrl ? { statusUrl: options.statusUrl } : {}),
  };
}

function registerDefaultHarnesses() {
  registerHarnessDriver("native", createNativeHarness, {
    displayName: "Native Tools",
    supportsInstances: false,
    getStatus: () => ({ availability: "available", checkedAt: getCheckedAt() }),
  });
  registerHarnessDriver("codex", createCodexHarness, {
    displayName: "Codex",
    supportsInstances: true,
    docsUrl: "https://developers.openai.com/codex",
  });
  registerHarnessDriver("pi", createPiHarness, {
    displayName: "Pi",
    supportsInstances: true,
  });
}

registerDefaultHarnesses();

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

/** @type {Pick<NormalizedHarnessCapabilities, "sessionModelSwitch" | "supportsRollback" | "supportsUserInputRequests">} */
const DEFAULT_HARNESS_SEAM_CAPABILITIES = {
  sessionModelSwitch: "in-session",
  supportsRollback: false,
  supportsUserInputRequests: false,
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
  const listSlashCommands = harness.listSlashCommands ?? (() => []);
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
    listSlashCommands,
    run,
  };
}

/**
 * @param {string | null | undefined} instanceId
 * @returns {string}
 */
function normalizeInstanceId(instanceId) {
  const trimmed = instanceId?.trim();
  return trimmed ? trimmed : "default";
}

/**
 * @param {string} name
 * @param {string} instanceId
 * @returns {string}
 */
function buildInstanceCacheKey(name, instanceId) {
  return `${name}\u0000${instanceId}`;
}

/**
 * @param {AgentHarness} harness
 * @returns {NormalizedHarnessCapabilities}
 */
function normalizeCapabilities(harness) {
  return {
    ...DEFAULT_HARNESS_CAPABILITIES,
    ...DEFAULT_HARNESS_SEAM_CAPABILITIES,
    ...harness.getCapabilities(),
  };
}

/**
 * @param {string} name
 * @param {string} instanceId
 * @returns {string}
 */
function buildContinuationKey(name, instanceId) {
  return `${name}:instance:${instanceId}`;
}

/**
 * @param {string} name
 * @param {{ instanceId?: string | null, config?: Record<string, unknown> }} [options]
 * @returns {HarnessInstance}
 */
export function resolveHarnessInstance(name, options = {}) {
  const key = name ?? "native";
  const driverOptionsForName = normalizeDriverOptions(key, driverOptions.get(key));
  const instanceId = driverOptionsForName.supportsInstances
    ? normalizeInstanceId(options.instanceId)
    : "default";
  const cacheKey = buildInstanceCacheKey(key, instanceId);
  const cached = instances.get(cacheKey);
  if (cached) return cached;

  const factory = registry.get(key);
  const createInstance = driverOptionsForName.createInstance;
  const harness = normalizeHarness(
    key,
    createInstance
      ? createInstance({ name: key, instanceId, config: options.config ?? {} })
      : factory
      ? factory()
      : createNativeHarness(),
  );
  const capabilities = normalizeCapabilities(harness);
  const continuationKey = buildContinuationKey(key, instanceId);
  const instance = {
    name: key,
    instanceId,
    displayName: driverOptionsForName.displayName,
    supportsInstances: driverOptionsForName.supportsInstances,
    continuationKey,
    capabilities,
    harness,
    adapter: createHarnessAdapterFromHarness({
      harness,
      name: key,
      instanceId,
      continuationKey,
    }),
  };
  instances.set(cacheKey, instance);
  return instance;
}

/**
 * Register a harness factory under a name.
 * @param {string} name
 * @param {HarnessDriverFactory} factory
 */
export function registerHarness(name, factory) {
  registerHarnessDriver(name, factory);
}

/**
 * Register a harness driver under a name with optional metadata and status.
 * @param {string} name
 * @param {HarnessDriverFactory} factory
 * @param {HarnessDriverOptions} [options]
 * @returns {void}
 */
export function registerHarnessDriver(name, factory, options = {}) {
  registry.set(name, factory);
  driverOptions.set(name, normalizeDriverOptions(name, options));
  for (const cacheKey of [...instances.keys()]) {
    if (cacheKey === name || cacheKey.startsWith(`${name}\u0000`)) {
      instances.delete(cacheKey);
    }
  }
}

/**
 * Test helper: restore the baseline registry and clear cached singleton instances.
 * Optional harnesses should be re-registered explicitly by each test that needs them.
 * @returns {void}
 */
export function resetHarnessRegistryForTests() {
  registry.clear();
  driverOptions.clear();
  instances.clear();
  registerDefaultHarnesses();
}

/**
 * Resolve a harness by name. Falls back to native if not found.
 * Returns a cached singleton so stateful harnesses preserve their per-chat active state.
 * @param {string} [name]
 * @param {{ instanceId?: string | null, config?: Record<string, unknown> }} [options]
 * @returns {AgentHarness}
 */
export function resolveHarness(name, options = {}) {
  return resolveHarnessInstance(name ?? "native", options).harness;
}

/**
 * List registered harness names.
 * @returns {string[]}
 */
export function listHarnesses() {
  return [...registry.keys()];
}

/**
 * List registered harness drivers and metadata without constructing harnesses.
 * @returns {HarnessDriverDescriptor[]}
 */
export function listHarnessDrivers() {
  return [...registry.keys()].map(getDriverDescriptor);
}

/**
 * List materialized harness instances.
 * @returns {Array<Pick<HarnessInstance, "name" | "instanceId" | "displayName" | "supportsInstances" | "continuationKey" | "capabilities">>}
 */
export function listHarnessInstances() {
  return [...instances.values()].map((instance) => ({
    name: instance.name,
    instanceId: instance.instanceId,
    displayName: instance.displayName,
    supportsInstances: instance.supportsInstances,
    continuationKey: instance.continuationKey,
    capabilities: instance.capabilities,
  }));
}

/**
 * Read provider status through the driver seam.
 * @param {string} name
 * @returns {Promise<HarnessDriverDescriptor & HarnessDriverStatus>}
 */
export async function getHarnessDriverStatus(name) {
  const descriptor = getDriverDescriptor(name);
  const options = driverOptions.get(name);
  if (!registry.has(name) || !options) {
    return {
      ...descriptor,
      availability: "unavailable",
      message: "Harness driver is not registered.",
      checkedAt: getCheckedAt(),
    };
  }
  if (!options.getStatus) {
    return {
      ...descriptor,
      availability: "unknown",
      message: "Harness driver does not expose a lightweight availability check.",
      checkedAt: getCheckedAt(),
    };
  }
  const status = await options.getStatus();
  return {
    ...descriptor,
    ...status,
    checkedAt: status.checkedAt ?? getCheckedAt(),
  };
}

/**
 * Read statuses for all registered harness drivers.
 * @returns {Promise<Array<HarnessDriverDescriptor & HarnessDriverStatus>>}
 */
export async function listHarnessDriverStatuses() {
  return Promise.all(listHarnesses().map((name) => getHarnessDriverStatus(name)));
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
      .map((instance) => instance.harness)
      .filter((harness) => typeof harness.waitForIdle === "function")
      .map((harness) => /** @type {() => Promise<string[]>} */ (harness.waitForIdle)()),
  );
  return results.flat();
}
