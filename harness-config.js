import { getRootDb } from "./db.js";

/**
 * @typedef {"claude-agent-sdk" | "codex" | "native"} SupportedHarnessName
 */

/** @type {Set<string>} */
const LEGACY_FLAT_CONFIG_KEYS = new Set([
  "model",
  "reasoningEffort",
  "sandboxMode",
  "approvalPolicy",
]);

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
      ?? (currentHarness === "claude-agent-sdk" || currentHarness === "codex"
        ? currentHarness
        : null);
    if (targetHarness) {
      const scoped = ensureScopedConfig(normalized, targetHarness);
      if (typeof scoped.model !== "string") {
        scoped.model = value.model;
      }
    }
  }

  if (typeof value.reasoningEffort === "string") {
    const scoped = ensureScopedConfig(normalized, "claude-agent-sdk");
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
 * @param {string} chatId
 * @param {string} harnessName
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getHarnessConfig(chatId, harnessName) {
  const db = getRootDb();
  const { rows: [row] } = await db.sql`SELECT harness_config, harness FROM chats WHERE chat_id = ${chatId}`;
  return getScopedHarnessConfig(row?.harness_config, harnessName || row?.harness);
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
  const db = getRootDb();
  const { rows: [row] } = await db.sql`SELECT harness_config, harness FROM chats WHERE chat_id = ${chatId}`;
  const root = normalizeHarnessConfig(row?.harness_config, row?.harness);
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
  await db.sql`UPDATE chats SET harness_config = ${JSON.stringify(root)} WHERE chat_id = ${chatId}`;
}
