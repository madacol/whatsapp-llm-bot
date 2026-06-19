import {
  BUILT_IN_ACP_AGENT_DEFINITIONS,
  createAcpAgentDriver,
  readAcpAgentDefinitionsFromEnv,
} from "./acp-agents.js";
import config from "../config.js";
import { getHarnessSessionDirectory } from "./session-directory.js";

/**
 * @typedef {{
 *   name: string,
 *   instanceId: string,
 *   continuationKey: string,
 *   config: Record<string, unknown>,
 *   displayName?: string,
 * }} HarnessDriverCreateInput
 */

/**
 * @typedef {{
 *   harness: AgentHarness,
 *   status?: HarnessDriverStatus,
 *   adapter?: HarnessAdapter,
 *   textGeneration?: AgentHarness["textGeneration"],
 *   dispose?: () => void | Promise<void>,
 * }} HarnessInstanceBundle
 */

/**
 * @typedef {(input: HarnessDriverCreateInput) => HarnessInstanceBundle} HarnessInstanceFactory
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
 *   adapter: HarnessAdapter | null,
 *   dispose?: () => void | Promise<void>,
 * }} HarnessInstance
 */

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
 *   name: string,
 *   displayName?: string,
 *   supportsInstances?: boolean,
 *   docsUrl?: string,
 *   statusUrl?: string,
 *   createInstance: HarnessInstanceFactory,
 *   configSchema?: (config: Record<string, unknown>) => Record<string, unknown>,
 *   defaultConfig?: () => Record<string, unknown>,
 *   getStatus?: () => Promise<HarnessDriverStatus> | HarnessDriverStatus,
 * }} HarnessDriver
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

/** @type {Map<string, Required<Pick<HarnessDriver, "displayName" | "supportsInstances">> & HarnessDriver>} */
const drivers = new Map();

/** @type {Map<string, HarnessInstance>} Singleton cache for stateful harness instances */
const instances = new Map();

/** @type {Map<string, string>} */
const instanceConfigSignatures = new Map();

/**
 * @param {string} name
 * @param {Omit<HarnessDriver, "name"> & { name?: string }} driver
 * @returns {Required<Pick<HarnessDriver, "displayName" | "supportsInstances">> & HarnessDriver}
 */
function normalizeDriver(name, driver) {
  return {
    ...driver,
    name,
    displayName: driver.displayName ?? name,
    supportsInstances: driver.supportsInstances ?? false,
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
 * @param {HarnessDriver} driver
 * @param {Record<string, unknown> | undefined} config
 * @returns {{ ok: true, config: Record<string, unknown> } | { ok: false, status: HarnessDriverStatus, config: Record<string, unknown> }}
 */
function decodeHarnessInstanceConfig(driver, config) {
  const baseConfig = config ?? driver.defaultConfig?.() ?? {};
  if (!driver.configSchema) {
    return { ok: true, config: { ...baseConfig } };
  }
  try {
    return { ok: true, config: driver.configSchema(baseConfig) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      config: { ...baseConfig },
      status: {
        availability: "unavailable",
        message: `Invalid config for harness driver "${driver.name}": ${message}`,
        checkedAt: getCheckedAt(),
      },
    };
  }
}

/**
 * @param {HarnessDriver | undefined} driver
 * @param {Record<string, unknown> | undefined} config
 * @returns {{ ok: true, config: Record<string, unknown> } | { ok: false, status: HarnessDriverStatus, config: Record<string, unknown> }}
 */
function decodeHarnessInstanceConfigForDriver(driver, config) {
  if (driver) {
    return decodeHarnessInstanceConfig(driver, config);
  }
  return { ok: true, config: { ...(config ?? {}) } };
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
  const driver = drivers.get(name) ?? normalizeDriver(name, {
    createInstance() {
      return { harness: createUnavailableHarness(name, { availability: "unavailable" }) };
    },
  });
  return {
    name,
    displayName: driver.displayName,
    supportsInstances: driver.supportsInstances,
    ...(driver.docsUrl ? { docsUrl: driver.docsUrl } : {}),
    ...(driver.statusUrl ? { statusUrl: driver.statusUrl } : {}),
  };
}

function registerDefaultHarnesses() {
  for (const definition of BUILT_IN_ACP_AGENT_DEFINITIONS) {
    registerHarnessDriver(createAcpAgentDriver(definition));
  }
  for (const definition of readAcpAgentDefinitionsFromEnv()) {
    registerHarnessDriver(createAcpAgentDriver(definition));
  }
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
 * Normalize optional harness methods so callers can rely on a small contract.
 * @param {string} name
 * @param {AgentHarness} harness
 * @returns {AgentHarness}
 */
function normalizeHarness(name, harness) {
  const getName = harness.getName ?? (() => name);
  const getCapabilities = harness.getCapabilities ?? (() => DEFAULT_HARNESS_CAPABILITIES);
  const handleCommand = harness.handleCommand ?? (async () => false);
  const listSlashCommands = harness.listSlashCommands ?? (() => []);
  const run = harness.run ?? (async () => {
    throw new Error(`Harness "${name}" does not implement run()`);
  });

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
 * @param {string} fallback
 * @returns {string}
 */
function normalizeInstanceId(instanceId, fallback = "default") {
  const trimmed = instanceId?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * @param {string} _name
 * @param {string} instanceId
 * @returns {string}
 */
function buildInstanceCacheKey(_name, instanceId) {
  return instanceId;
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
 * @param {{
 *   name: string,
 *   instanceId: string,
 *   displayName: string,
 *   supportsInstances: boolean,
 *   continuationKey: string,
 *   status: HarnessDriverStatus,
 * }} input
 * @returns {HarnessInstance}
 */
function createUnavailableHarnessInstance(input) {
  const harness = normalizeHarness(input.name, createUnavailableHarness(input.name, input.status));
  const capabilities = normalizeCapabilities(harness);
  return {
    name: input.name,
    instanceId: input.instanceId,
    displayName: input.displayName,
    supportsInstances: input.supportsInstances,
    continuationKey: input.continuationKey,
    capabilities,
    available: false,
    status: input.status,
    harness,
    adapter: null,
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
  if (typeof instance.dispose === "function") {
    await instance.dispose();
    return;
  }
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
  const key = name;
  const driver = drivers.get(key);
  const driverIsRegistered = !!driver;
  const instanceId = driver?.supportsInstances || !driverIsRegistered
    ? normalizeInstanceId(options.instanceId, key)
    : key;
  const cacheKey = buildInstanceCacheKey(key, instanceId);
  const decoded = decodeHarnessInstanceConfigForDriver(driver, options.config);
  const decodedConfig = decoded.config;
  const configSignature = stableConfigSignature({
    config: decodedConfig,
    displayName: options.displayName ?? null,
    status: decoded.ok ? null : decoded.status.message ?? null,
  });
  const cached = instances.get(cacheKey);
  if (cached && instanceConfigSignatures.get(cacheKey) === configSignature) return cached;
  if (cached) {
    void disposeHarnessInstance(cached);
    instances.delete(cacheKey);
    instanceConfigSignatures.delete(cacheKey);
  }

  const continuationKey = buildContinuationKey(key, instanceId);
  if (!driver) {
    /** @type {HarnessDriverStatus} */
    const status = {
      availability: "unavailable",
      message: `Harness driver "${key}" is not registered in this build.`,
      checkedAt: getCheckedAt(),
    };
    const instance = createUnavailableHarnessInstance({
      name: key,
      instanceId,
      displayName: options.displayName ?? key,
      supportsInstances: true,
      continuationKey,
      status,
    });
    instances.set(cacheKey, instance);
    instanceConfigSignatures.set(cacheKey, configSignature);
    return instance;
  }
  if (!decoded.ok) {
    const instance = createUnavailableHarnessInstance({
      name: key,
      instanceId,
      displayName: options.displayName ?? driver.displayName,
      supportsInstances: driver.supportsInstances,
      continuationKey,
      status: decoded.status,
    });
    instances.set(cacheKey, instance);
    instanceConfigSignatures.set(cacheKey, configSignature);
    return instance;
  }

  const bundle = driver.createInstance({
    name: key,
    instanceId,
    continuationKey,
    config: decodedConfig,
    displayName: options.displayName,
  });
  const harness = normalizeHarness(key, bundle.harness);
  const capabilities = normalizeCapabilities(harness);
  const adapter = bundle.adapter ?? harness.createAdapter?.({ name: key, instanceId, continuationKey }) ?? null;
  /** @type {HarnessDriverStatus} */
  const baseStatus = bundle.status ?? {
    availability: "available",
    checkedAt: getCheckedAt(),
  };
  /** @type {HarnessDriverStatus} */
  const status = adapter ? baseStatus : {
    availability: "unavailable",
    message: `Harness driver "${key}" did not provide a semantic adapter.`,
    checkedAt: getCheckedAt(),
  };
  const instance = {
    name: key,
    instanceId,
    displayName: options.displayName ?? driver.displayName,
    supportsInstances: driver.supportsInstances,
    continuationKey,
    capabilities,
    available: status.availability !== "unavailable",
    status,
    textGeneration: normalizeTextGeneration(bundle.textGeneration ?? harness.textGeneration),
    harness,
    adapter,
    dispose: bundle.dispose,
  };
  instances.set(cacheKey, instance);
  instanceConfigSignatures.set(cacheKey, configSignature);
  return instance;
}

/**
 * Register a harness driver value object.
 * @param {HarnessDriver} driver
 * @returns {void}
 */
export function registerHarnessDriver(driver) {
  const normalized = normalizeDriver(driver.name, driver);
  drivers.set(normalized.name, normalized);
  for (const [cacheKey, instance] of [...instances.entries()]) {
    if (instance.name === normalized.name) {
      void disposeHarnessInstance(instance);
      instances.delete(cacheKey);
      instanceConfigSignatures.delete(cacheKey);
    }
  }
}

/**
 * Register an ACP-backed harness driver from a provider definition.
 * @param {AcpAgentDefinition} definition
 * @returns {void}
 */
export function registerAcpAgentDriver(definition) {
  registerHarnessDriver(createAcpAgentDriver(definition));
}

/**
 * Register multiple ACP-backed harness drivers from provider definitions.
 * @param {AcpAgentDefinition[]} definitions
 * @returns {void}
 */
export function registerAcpAgentDrivers(definitions) {
  for (const definition of definitions) {
    registerAcpAgentDriver(definition);
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
    const driver = drivers.get(entry.name);
    const driverIsRegistered = !!driver;
    const instanceId = driver?.supportsInstances || !driverIsRegistered
      ? normalizeInstanceId(entry.instanceId, entry.name)
      : entry.name;
    const cacheKey = buildInstanceCacheKey(entry.name, instanceId);
    desiredKeys.add(cacheKey);
    const decoded = decodeHarnessInstanceConfigForDriver(driver, entry.config);
    const nextSignature = stableConfigSignature({
      config: decoded.config,
      displayName: entry.displayName ?? null,
      status: decoded.ok ? null : decoded.status.message ?? null,
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
  drivers.clear();
  for (const instance of instances.values()) {
    void disposeHarnessInstance(instance);
  }
  instances.clear();
  instanceConfigSignatures.clear();
  registerDefaultHarnesses();
}

/**
 * Resolve a registered provider harness by name.
 * Returns a cached singleton so stateful harnesses preserve their per-chat active state.
 * @param {string} name
 * @param {{ instanceId?: string | null, config?: Record<string, unknown> }} [options]
 * @returns {AgentHarness}
 */
export function resolveHarness(name, options = {}) {
  return resolveHarnessInstance(name, options).harness;
}

/**
 * List registered harness names.
 * @returns {string[]}
 */
export function listHarnesses() {
  return [...drivers.keys()];
}

/**
 * List registered harness drivers and metadata without constructing harnesses.
 * @returns {HarnessDriverDescriptor[]}
 */
export function listHarnessDrivers() {
  return [...drivers.keys()].map(getDriverDescriptor);
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
  const driver = drivers.get(name);
  if (!driver) {
    return {
      ...descriptor,
      availability: "unavailable",
      message: "Harness driver is not registered.",
      checkedAt: getCheckedAt(),
    };
  }
  if (!driver.getStatus) {
    return {
      ...descriptor,
      availability: "unknown",
      message: "Harness driver does not expose a lightweight availability check.",
      checkedAt: getCheckedAt(),
    };
  }
  const status = await driver.getStatus();
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
 * @returns {string | null}
 */
export function resolveHarnessName(persona, chatInfo) {
  const harnessName = persona?.harness ?? chatInfo?.harness ?? null;
  if (harnessName && harnessName !== "app") {
    return harnessName;
  }
  const defaultHarness = config.default_harness.trim();
  return defaultHarness || null;
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

/**
 * List active harness sessions without waiting for them to finish.
 * @returns {import("../restart/restart-ack-store.js").RestartInterruptedTurn[]}
 */
export function listActiveHarnessSessions() {
  const directory = getHarnessSessionDirectory();
  return [...instances.values()]
    .flatMap((instance) => {
      if (typeof instance.harness.listActiveSessions !== "function") {
        return [];
      }
      return instance.harness.listActiveSessions().map((chatId) => {
        const binding = directory.getBinding(chatId);
        return {
          chatId,
          label: instance.displayName ?? instance.name,
          ...(binding?.activeTurnId ? { activeTurnId: binding.activeTurnId } : {}),
          ...(binding?.resumeCursor ? { resumeCursor: binding.resumeCursor } : {}),
          ...(binding?.status ? { status: binding.status } : {}),
        };
      });
    });
}
