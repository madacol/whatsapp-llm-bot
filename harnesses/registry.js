import { createNativeHarness } from "./native.js";
import { createCodexHarness } from "./codex.js";
import { createPiHarness } from "./pi.js";
import { createHarnessAdapterFromHarness } from "./adapter.js";

/**
 * @typedef {{
 *   name: string,
 *   instanceId: string,
 *   config: Record<string, unknown>,
 *   displayName?: string,
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
 *   available: boolean,
 *   status: HarnessDriverStatus,
 *   textGeneration?: AgentHarness["textGeneration"],
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
 *   configSchema?: (config: Record<string, unknown>) => Record<string, unknown>,
 *   defaultConfig?: () => Record<string, unknown>,
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

/** @type {Map<string, string>} */
const instanceConfigSignatures = new Map();

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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function stableConfigSignature(config) {
  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  const normalize = (value) => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (!isObjectRecord(value)) {
      return value;
    }
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalize(value[key]);
    }
    return sorted;
  };
  return JSON.stringify(normalize(config));
}

/**
 * @param {HarnessDriverOptions} options
 * @param {Record<string, unknown> | undefined} config
 * @returns {Record<string, unknown>}
 */
function decodeHarnessInstanceConfig(options, config) {
  const baseConfig = config ?? options.defaultConfig?.() ?? {};
  if (!options.configSchema) {
    return { ...baseConfig };
  }
  return options.configSchema(baseConfig);
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
 * @param {HarnessDriverStatus} status
 * @returns {AgentHarness}
 */
function createUnavailableHarness(name, status) {
  return {
    getName: () => name,
    getCapabilities: () => DEFAULT_HARNESS_CAPABILITIES,
    async run() {
      throw new Error(status.message ?? `Harness driver "${name}" is unavailable.`);
    },
    handleCommand: async () => false,
    listSlashCommands: () => [],
  };
}

/**
 * @param {AgentHarness["textGeneration"] | undefined} textGeneration
 * @returns {AgentHarness["textGeneration"] | undefined}
 */
function normalizeTextGeneration(textGeneration) {
  if (!textGeneration?.generateSessionTitle) {
    return undefined;
  }
  return {
    async generateSessionTitle(input) {
      const generated = await textGeneration.generateSessionTitle?.(input);
      if (typeof generated === "string" || generated === null) {
        return generated;
      }
      return generated?.title ?? null;
    },
  };
}

/**
 * @param {HarnessInstance} instance
 * @returns {Promise<void>}
 */
async function disposeHarnessInstance(instance) {
  if (typeof instance.harness.dispose === "function") {
    await instance.harness.dispose();
    return;
  }
  if (typeof instance.harness.waitForIdle === "function") {
    await instance.harness.waitForIdle();
  }
}

/**
 * @param {string} name
 * @param {{ instanceId?: string | null, config?: Record<string, unknown>, displayName?: string }} [options]
 * @returns {HarnessInstance}
 */
export function resolveHarnessInstance(name, options = {}) {
  const key = name ?? "native";
  const driverOptionsForName = normalizeDriverOptions(key, driverOptions.get(key));
  const driverIsRegistered = registry.has(key) || !!driverOptionsForName.createInstance;
  const instanceId = driverOptionsForName.supportsInstances || !driverIsRegistered
    ? normalizeInstanceId(options.instanceId)
    : "default";
  const cacheKey = buildInstanceCacheKey(key, instanceId);
  const decodedConfig = decodeHarnessInstanceConfig(driverOptionsForName, options.config);
  const configSignature = stableConfigSignature({
    config: decodedConfig,
    displayName: options.displayName ?? null,
  });
  const cached = instances.get(cacheKey);
  if (cached && instanceConfigSignatures.get(cacheKey) === configSignature) return cached;
  if (cached) {
    void disposeHarnessInstance(cached);
    instances.delete(cacheKey);
    instanceConfigSignatures.delete(cacheKey);
  }

  const factory = registry.get(key);
  const createInstance = driverOptionsForName.createInstance;
  const continuationKey = buildContinuationKey(key, instanceId);
  if (!factory && !createInstance) {
    /** @type {HarnessDriverStatus} */
    const status = {
      availability: "unavailable",
      message: `Harness driver "${key}" is not registered in this build.`,
      checkedAt: getCheckedAt(),
    };
    const harness = normalizeHarness(key, createUnavailableHarness(key, status));
    const capabilities = normalizeCapabilities(harness);
    const instance = {
      name: key,
      instanceId,
      displayName: options.displayName ?? driverOptionsForName.displayName,
      supportsInstances: true,
      continuationKey,
      capabilities,
      available: false,
      status,
      harness,
      adapter: createHarnessAdapterFromHarness({
        harness,
        name: key,
        instanceId,
        continuationKey,
      }),
    };
    instances.set(cacheKey, instance);
    instanceConfigSignatures.set(cacheKey, configSignature);
    return instance;
  }
  const harness = normalizeHarness(
    key,
    createInstance
      ? createInstance({ name: key, instanceId, config: decodedConfig, displayName: options.displayName })
      : factory
      ? factory()
      : createNativeHarness(),
  );
  const capabilities = normalizeCapabilities(harness);
  /** @type {HarnessDriverStatus} */
  const status = {
    availability: "available",
    checkedAt: getCheckedAt(),
  };
  const instance = {
    name: key,
    instanceId,
    displayName: options.displayName ?? driverOptionsForName.displayName,
    supportsInstances: driverOptionsForName.supportsInstances,
    continuationKey,
    capabilities,
    available: true,
    status,
    textGeneration: normalizeTextGeneration(harness.textGeneration),
    harness,
    adapter: harness.createAdapter
      ? harness.createAdapter({ name: key, instanceId, continuationKey })
      : createHarnessAdapterFromHarness({
          harness,
          name: key,
          instanceId,
          continuationKey,
        }),
  };
  instances.set(cacheKey, instance);
  instanceConfigSignatures.set(cacheKey, configSignature);
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
      const instance = instances.get(cacheKey);
      if (instance) {
        void disposeHarnessInstance(instance);
      }
      instances.delete(cacheKey);
      instanceConfigSignatures.delete(cacheKey);
    }
  }
}

/**
 * Reconcile the materialized instance cache against a desired instance list.
 * Changed entries are disposed and rebuilt; unchanged entries keep their
 * current process/session state.
 * @param {Array<{ name: string, instanceId?: string | null, config?: Record<string, unknown>, displayName?: string }>} desired
 * @returns {Promise<void>}
 */
export async function reconcileHarnessInstances(desired) {
  const desiredNames = new Set(desired.map((entry) => entry.name));
  const desiredKeys = new Set();
  for (const entry of desired) {
    const options = normalizeDriverOptions(entry.name, driverOptions.get(entry.name));
    const driverIsRegistered = registry.has(entry.name) || !!options.createInstance;
    const instanceId = options.supportsInstances || !driverIsRegistered
      ? normalizeInstanceId(entry.instanceId)
      : "default";
    const cacheKey = buildInstanceCacheKey(entry.name, instanceId);
    desiredKeys.add(cacheKey);
    const decodedConfig = decodeHarnessInstanceConfig(options, entry.config);
    const nextSignature = stableConfigSignature({
      config: decodedConfig,
      displayName: entry.displayName ?? null,
    });
    const cached = instances.get(cacheKey);
    if (cached && instanceConfigSignatures.get(cacheKey) !== nextSignature) {
      await disposeHarnessInstance(cached);
      instances.delete(cacheKey);
      instanceConfigSignatures.delete(cacheKey);
    }
  }

  for (const [cacheKey, instance] of [...instances.entries()]) {
    if (!desiredNames.has(instance.name) || desiredKeys.has(cacheKey)) {
      continue;
    }
    await disposeHarnessInstance(instance);
    instances.delete(cacheKey);
    instanceConfigSignatures.delete(cacheKey);
  }

  for (const entry of desired) {
    resolveHarnessInstance(entry.name, {
      instanceId: entry.instanceId,
      config: entry.config,
      displayName: entry.displayName,
    });
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
  for (const instance of instances.values()) {
    void disposeHarnessInstance(instance);
  }
  instances.clear();
  instanceConfigSignatures.clear();
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
