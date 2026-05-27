import { ensureChatConfig, updateChatConfig } from "./chat-config.js";

/**
 * @typedef {string} SupportedHarnessName
 */

/** @type {Set<string>} */
const LEGACY_FLAT_CONFIG_KEYS = new Set([
  "model",
  "mode",
  "reasoningEffort",
  "sandboxMode",
  "approvalPolicy",
  "approvalsReviewer",
]);

export const DEFAULT_HARNESS_INSTANCE_ID = "default";
export const HARNESS_INSTANCES_CONFIG_KEY = "harnessInstances";
export const ACTIVE_HARNESS_INSTANCES_CONFIG_KEY = "activeHarnessInstances";
export const ACTIVE_HARNESS_INSTANCE_ID_CONFIG_KEY = "activeHarnessInstanceId";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} root
 * @param {string} harnessName
 * @returns {Record<string, unknown>}
 */
function ensureScopedConfig(root, harnessName) {
  const existing = root[harnessName];
  if (isObjectRecord(existing)) {
    return existing;
  }
  /** @type {Record<string, unknown>} */
  const created = {};
  root[harnessName] = created;
  return created;
}

/**
 * @param {Record<string, unknown>} root
 * @returns {Record<string, unknown>}
 */
function ensureHarnessInstancesRoot(root) {
  const existing = root[HARNESS_INSTANCES_CONFIG_KEY];
  if (isObjectRecord(existing)) {
    return existing;
  }
  /** @type {Record<string, unknown>} */
  const created = {};
  root[HARNESS_INSTANCES_CONFIG_KEY] = created;
  return created;
}

/**
 * @param {Record<string, unknown>} root
 * @returns {Record<string, unknown>}
 */
function ensureActiveHarnessInstancesRoot(root) {
  const existing = root[ACTIVE_HARNESS_INSTANCES_CONFIG_KEY];
  if (isObjectRecord(existing)) {
    return existing;
  }
  /** @type {Record<string, unknown>} */
  const created = {};
  root[ACTIVE_HARNESS_INSTANCES_CONFIG_KEY] = created;
  return created;
}

/**
 * @param {Record<string, unknown>} root
 * @param {string} harnessName
 * @returns {Record<string, unknown>}
 */
function ensureHarnessInstanceGroup(root, harnessName) {
  const instancesRoot = ensureHarnessInstancesRoot(root);
  const existing = instancesRoot[harnessName];
  if (isObjectRecord(existing)) {
    return existing;
  }
  /** @type {Record<string, unknown>} */
  const created = {};
  instancesRoot[harnessName] = created;
  return created;
}

/**
 * @param {Record<string, unknown>} root
 * @returns {Record<string, unknown>}
 */
function cloneNonLegacyEntries(root) {
  /** @type {Record<string, unknown>} */
  const cloned = {};
  for (const [key, value] of Object.entries(root)) {
    if (LEGACY_FLAT_CONFIG_KEYS.has(key)) {
      continue;
    }
    cloned[key] = isObjectRecord(value) ? { ...value } : value;
  }
  return cloned;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeHarnessInstanceId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * @param {string | null | undefined} harnessName
 * @returns {string}
 */
function defaultInstanceIdForDriver(harnessName) {
  return harnessName?.trim() || DEFAULT_HARNESS_INSTANCE_ID;
}

/**
 * @param {Record<string, unknown>} envelope
 * @returns {Record<string, unknown>}
 */
function readCanonicalInstanceConfig(envelope) {
  const nestedConfig = envelope.config;
  if (isObjectRecord(nestedConfig)) {
    return { ...nestedConfig };
  }
  const { driver: _driver, displayName: _displayName, accentColor: _accentColor, environment: _environment, enabled: _enabled, ...legacyConfig } = envelope;
  return legacyConfig;
}

/**
 * @param {Record<string, unknown>} normalized
 * @param {string | null | undefined} harnessName
 * @returns {{ envelope: Record<string, unknown>, instanceId: string } | null}
 */
function findActiveCanonicalHarnessInstance(normalized, harnessName) {
  if (!harnessName) {
    return null;
  }
  const activeInstanceId = normalizeHarnessInstanceId(
    normalized[ACTIVE_HARNESS_INSTANCE_ID_CONFIG_KEY],
  );
  const instancesRoot = normalized[HARNESS_INSTANCES_CONFIG_KEY];
  if (!activeInstanceId || !isObjectRecord(instancesRoot)) {
    return null;
  }
  const envelope = instancesRoot[activeInstanceId];
  if (!isObjectRecord(envelope)) {
    return null;
  }
  const driver = typeof envelope.driver === "string" && envelope.driver.trim()
    ? envelope.driver.trim()
    : harnessName;
  if (driver !== harnessName) {
    return null;
  }
  return { envelope, instanceId: activeInstanceId };
}

/**
 * @param {string} model
 * @returns {SupportedHarnessName | null}
 */
function classifyLegacyModel(model) {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized === "sonnet"
    || normalized === "opus"
    || normalized === "haiku"
    || normalized.startsWith("claude")
  ) {
    return "claude-agent-sdk";
  }
  if (
    normalized.includes("codex")
    || normalized === "gpt-5.4"
    || normalized === "gpt-5.4-mini"
  ) {
    return "codex";
  }
  return null;
}

/** @type {Set<HarnessRunConfig["sandboxMode"]>} */
export const CODEX_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/** @type {NonNullable<HarnessRunConfig["sandboxMode"]>} */
export const DEFAULT_CODEX_SANDBOX_MODE = "workspace-write";

/**
 * @param {Record<string, unknown>} config
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]>}
 */
export function getEffectiveCodexSandboxMode(config) {
  if (typeof config.sandboxMode === "string" && CODEX_SANDBOX_MODES.has(/** @type {HarnessRunConfig["sandboxMode"]} */ (config.sandboxMode))) {
    return /** @type {NonNullable<HarnessRunConfig["sandboxMode"]>} */ (config.sandboxMode);
  }
  return DEFAULT_CODEX_SANDBOX_MODE;
}

/**
 * @param {string} value
 * @returns {NonNullable<HarnessRunConfig["sandboxMode"]> | null}
 */
export function normalizeCodexPermissionsMode(value) {
  if (value === "write" || value === "workspace" || value === "workspace-write") {
    return "workspace-write";
  }
  if (value === "readonly" || value === "read-only" || value === "read") {
    return "read-only";
  }
  if (value === "full" || value === "full-access" || value === "danger-full-access") {
    return "danger-full-access";
  }
  return null;
}

/**
 * Normalize stored harness_config into harness-scoped namespaces.
 * Legacy flat keys are migrated into the most likely harness bucket.
 * @param {unknown} value
 * @param {string | null | undefined} currentHarness
 * @returns {Record<string, unknown>}
 */
export function normalizeHarnessConfig(value, currentHarness) {
  if (!isObjectRecord(value)) {
    return {};
  }

  const normalized = cloneNonLegacyEntries(value);

  if (typeof value.model === "string") {
    const targetHarness = classifyLegacyModel(value.model)
      ?? (currentHarness === "claude-agent-sdk" || currentHarness === "codex" || currentHarness === "pi"
        ? currentHarness
        : null);
    if (targetHarness) {
      const scoped = ensureScopedConfig(normalized, targetHarness);
      if (typeof scoped.model !== "string") {
        scoped.model = value.model;
      }
    }
  }

  if (typeof value.mode === "string") {
    const targetHarness = currentHarness ?? null;
    if (targetHarness) {
      const scoped = ensureScopedConfig(normalized, targetHarness);
      if (typeof scoped.mode !== "string") {
        scoped.mode = value.mode;
      }
    }
  }

  if (typeof value.reasoningEffort === "string") {
    const targetHarness = currentHarness === "pi" ? "pi" : "claude-agent-sdk";
    const scoped = ensureScopedConfig(normalized, targetHarness);
    if (typeof scoped.reasoningEffort !== "string") {
      scoped.reasoningEffort = value.reasoningEffort;
    }
  }

  if (typeof value.sandboxMode === "string") {
    const scoped = ensureScopedConfig(normalized, "codex");
    if (typeof scoped.sandboxMode !== "string") {
      scoped.sandboxMode = value.sandboxMode;
    }
  }

  if (typeof value.approvalPolicy === "string") {
    const scoped = ensureScopedConfig(normalized, "codex");
    if (typeof scoped.approvalPolicy !== "string") {
      scoped.approvalPolicy = value.approvalPolicy;
    }
  }

  return normalized;
}

/**
 * @param {unknown} value
 * @param {string | null | undefined} harnessName
 * @returns {Record<string, unknown>}
 */
export function getScopedHarnessConfig(value, harnessName) {
  const normalized = normalizeHarnessConfig(value, harnessName);
  if (!harnessName) {
    return {};
  }
  const scoped = normalized[harnessName];
  return isObjectRecord(scoped) ? { ...scoped } : {};
}

/**
 * Resolve the selected provider instance and its isolated config. Canonical
 * envelopes route by instance id and carry the driver kind; legacy scoped
 * harness config falls back to an instance id matching the driver kind.
 * @param {unknown} value
 * @param {string | null | undefined} harnessName
 * @returns {{ driver: string | null, instanceId: string, config: Record<string, unknown>, displayName?: string }}
 */
export function getHarnessInstanceConfig(value, harnessName) {
  const normalized = normalizeHarnessConfig(value, harnessName);
  if (!harnessName) {
    return { driver: null, instanceId: DEFAULT_HARNESS_INSTANCE_ID, config: {} };
  }

  const canonicalActiveInstanceId = normalizeHarnessInstanceId(
    normalized[ACTIVE_HARNESS_INSTANCE_ID_CONFIG_KEY],
  );
  const instancesRoot = normalized[HARNESS_INSTANCES_CONFIG_KEY];
  if (canonicalActiveInstanceId && isObjectRecord(instancesRoot)) {
    const canonicalInstance = instancesRoot[canonicalActiveInstanceId];
    if (isObjectRecord(canonicalInstance)) {
      const driver = typeof canonicalInstance.driver === "string" ? canonicalInstance.driver : harnessName;
      return {
        driver,
        instanceId: canonicalActiveInstanceId,
        config: readCanonicalInstanceConfig(canonicalInstance),
        ...(typeof canonicalInstance.displayName === "string"
          ? { displayName: canonicalInstance.displayName }
          : {}),
      };
    }
  }

  const activeInstances = normalized[ACTIVE_HARNESS_INSTANCES_CONFIG_KEY];
  const activeInstanceId = isObjectRecord(activeInstances)
    ? normalizeHarnessInstanceId(activeInstances[harnessName])
    : null;

  if (!activeInstanceId || activeInstanceId === DEFAULT_HARNESS_INSTANCE_ID) {
    return {
      driver: harnessName,
      instanceId: defaultInstanceIdForDriver(harnessName),
      config: getScopedHarnessConfig(normalized, harnessName),
    };
  }

  const harnessInstances = isObjectRecord(instancesRoot) ? instancesRoot[harnessName] : null;
  const instanceConfig = isObjectRecord(harnessInstances)
    ? harnessInstances[activeInstanceId]
    : null;

  return {
    driver: harnessName,
    instanceId: activeInstanceId,
    config: isObjectRecord(instanceConfig) ? { ...instanceConfig } : {},
  };
}

/**
 * @param {string} chatId
 * @param {string} harnessName
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getHarnessConfig(chatId, harnessName) {
  const chat = await ensureChatConfig(chatId);
  return getScopedHarnessConfig(chat.harness_config, harnessName || chat.harness);
}

/**
 * Read the selected harness config. Canonical instance envelopes win over the
 * legacy driver-scoped namespace so commands mutate the same instance that the
 * runner resolves.
 * @param {string} chatId
 * @param {string} harnessName
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getActiveHarnessConfig(chatId, harnessName) {
  const chat = await ensureChatConfig(chatId);
  const normalized = normalizeHarnessConfig(chat.harness_config, chat.harness);
  const canonical = findActiveCanonicalHarnessInstance(normalized, harnessName || chat.harness);
  if (canonical) {
    return readCanonicalInstanceConfig(canonical.envelope);
  }
  return getScopedHarnessConfig(normalized, harnessName || chat.harness);
}

/**
 * Update the scoped harness configuration for a chat.
 * Null/undefined values remove keys from that harness namespace.
 * @param {string} chatId
 * @param {string} harnessName
 * @param {Record<string, unknown>} patch
 * @returns {Promise<void>}
 */
export async function updateHarnessConfig(chatId, harnessName, patch) {
  const chat = await ensureChatConfig(chatId);
  const root = normalizeHarnessConfig(chat.harness_config, chat.harness);
  const scoped = ensureScopedConfig(root, harnessName);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) {
      delete scoped[key];
    } else {
      scoped[key] = value;
    }
  }
  if (Object.keys(scoped).length === 0) {
    delete root[harnessName];
  }
  await updateChatConfig(chatId, (current) => ({ ...current, harness_config: root }));
}

/**
 * Update the selected harness config. Canonical instance envelopes win over the
 * legacy driver-scoped namespace so provider commands are instance-aware.
 * @param {string} chatId
 * @param {string} harnessName
 * @param {Record<string, unknown>} patch
 * @returns {Promise<void>}
 */
export async function updateActiveHarnessConfig(chatId, harnessName, patch) {
  const chat = await ensureChatConfig(chatId);
  const root = normalizeHarnessConfig(chat.harness_config, chat.harness);
  const canonical = findActiveCanonicalHarnessInstance(root, harnessName || chat.harness);
  if (canonical) {
    const nextConfig = readCanonicalInstanceConfig(canonical.envelope);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) {
        delete nextConfig[key];
      } else {
        nextConfig[key] = value;
      }
    }
    if (Object.keys(nextConfig).length === 0) {
      delete canonical.envelope.config;
    } else {
      canonical.envelope.config = nextConfig;
    }
    await updateChatConfig(chatId, (current) => ({ ...current, harness_config: root }));
    return;
  }
  await updateHarnessConfig(chatId, harnessName, patch);
}

/**
 * Select the provider instance to use for future runs of this harness.
 * Passing null/undefined/default clears the selection back to the legacy
 * harness namespace.
 * @param {string} chatId
 * @param {string} harnessName
 * @param {string | null | undefined} instanceId
 * @returns {Promise<void>}
 */
export async function setActiveHarnessInstance(chatId, harnessName, instanceId) {
  const chat = await ensureChatConfig(chatId);
  const root = normalizeHarnessConfig(chat.harness_config, chat.harness);
  const activeInstances = ensureActiveHarnessInstancesRoot(root);
  const normalizedInstanceId = normalizeHarnessInstanceId(instanceId);
  if (!normalizedInstanceId || normalizedInstanceId === DEFAULT_HARNESS_INSTANCE_ID) {
    delete activeInstances[harnessName];
  } else {
    activeInstances[harnessName] = normalizedInstanceId;
  }
  if (Object.keys(activeInstances).length === 0) {
    delete root[ACTIVE_HARNESS_INSTANCES_CONFIG_KEY];
  }
  await updateChatConfig(chatId, (current) => ({ ...current, harness_config: root }));
}

/**
 * Update an isolated provider instance config. The default instance delegates
 * to the legacy scoped harness config for backwards compatibility.
 * @param {string} chatId
 * @param {string} harnessName
 * @param {string} instanceId
 * @param {Record<string, unknown>} patch
 * @returns {Promise<void>}
 */
export async function updateHarnessInstanceConfig(chatId, harnessName, instanceId, patch) {
  const normalizedInstanceId = normalizeHarnessInstanceId(instanceId) ?? DEFAULT_HARNESS_INSTANCE_ID;
  if (normalizedInstanceId === DEFAULT_HARNESS_INSTANCE_ID) {
    await updateHarnessConfig(chatId, harnessName, patch);
    return;
  }

  const chat = await ensureChatConfig(chatId);
  const root = normalizeHarnessConfig(chat.harness_config, chat.harness);
  const harnessInstances = ensureHarnessInstanceGroup(root, harnessName);
  const existing = harnessInstances[normalizedInstanceId];
  /** @type {Record<string, unknown>} */
  const config = isObjectRecord(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) {
      delete config[key];
    } else {
      config[key] = value;
    }
  }
  if (Object.keys(config).length === 0) {
    delete harnessInstances[normalizedInstanceId];
  } else {
    harnessInstances[normalizedInstanceId] = config;
  }

  const instancesRoot = root[HARNESS_INSTANCES_CONFIG_KEY];
  if (isObjectRecord(instancesRoot)) {
    if (Object.keys(harnessInstances).length === 0) {
      delete instancesRoot[harnessName];
    }
    if (Object.keys(instancesRoot).length === 0) {
      delete root[HARNESS_INSTANCES_CONFIG_KEY];
    }
  }

  await updateChatConfig(chatId, (current) => ({ ...current, harness_config: root }));
}
