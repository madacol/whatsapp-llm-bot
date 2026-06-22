/**
 * Shared semantics for chat-configurable agent progress visibility.
 */

/**
 * @typedef {"toolStatus" | "thinking" | "changes" | "subagents"} OutputVisibilityKey
 *
 * @typedef {{
 *   tools?: boolean;
 *   commands?: boolean;
 *   toolStatus?: boolean;
 *   thinking?: boolean;
 *   changes?: boolean;
 *   subagents?: boolean;
 * }} OutputVisibilityOverrides
 *
 * @typedef {{
 *   toolDetails: boolean;
 *   toolStatus: boolean;
 *   thinking: boolean;
 *   changes: boolean;
 *   subagents: boolean;
 * }} OutputVisibility
 *
 * @typedef {{
 *   key: OutputVisibilityKey;
 *   label: string;
 *   description: string;
 *   defaultValue: boolean;
 * }} OutputVisibilityFlagDefinition
 */

/** @type {readonly OutputVisibilityFlagDefinition[]} */
export const OUTPUT_VISIBILITY_FLAGS = Object.freeze([
  {
    key: "toolStatus",
    label: "tool status",
    description: "Show tool and command progress as one pinned status message instead of individual messages.",
    defaultValue: false,
  },
  {
    key: "thinking",
    label: "thinking",
    description: "Show reasoning placeholders and inspectable thinking summaries when available.",
    defaultValue: true,
  },
  {
    key: "changes",
    label: "changes",
    description: "Show file changes and diff-style output from edits.",
    defaultValue: true,
  },
  {
    key: "subagents",
    label: "subagents",
    description: "Show final responses from spawned sub-agents.",
    defaultValue: true,
  },
]);

/** @type {OutputVisibility} */
export const DEFAULT_OUTPUT_VISIBILITY = Object.freeze({
  toolDetails: false,
  toolStatus: false,
  thinking: true,
  changes: true,
  subagents: true,
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {value is OutputVisibilityKey}
 */
export function isOutputVisibilityKey(value) {
  const trimmed = value.trim();
  return OUTPUT_VISIBILITY_FLAGS.some((flag) => flag.key.toLowerCase() === trimmed.toLowerCase());
}

/**
 * @param {unknown} raw
 * @returns {OutputVisibilityOverrides}
 */
export function normalizeOutputVisibility(raw) {
  if (!isRecord(raw)) {
    return {};
  }

  /** @type {OutputVisibilityOverrides} */
  const normalized = {};
  const toolStatus = raw.toolStatus;
  if (typeof toolStatus === "boolean") {
    normalized.toolStatus = toolStatus;
  }

  const thinking = raw.thinking;
  if (typeof thinking === "boolean") {
    normalized.thinking = thinking;
  }

  const changes = raw.changes;
  if (typeof changes === "boolean") {
    normalized.changes = changes;
  }

  const subagents = raw.subagents;
  if (typeof subagents === "boolean") {
    normalized.subagents = subagents;
  }
  return normalized;
}

/**
 * @param {unknown} raw
 * @returns {OutputVisibility}
 */
export function resolveOutputVisibility(raw) {
  return {
    ...DEFAULT_OUTPUT_VISIBILITY,
    ...normalizeOutputVisibility(raw),
  };
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function formatOutputVisibility(raw) {
  const visibility = resolveOutputVisibility(raw);
  return OUTPUT_VISIBILITY_FLAGS
    .map((flag) => `${flag.label} ${visibility[flag.key] ? "on" : "off"}`)
    .join(", ");
}

/**
 * @returns {string}
 */
export function formatOutputVisibilityDefault() {
  return formatOutputVisibility(DEFAULT_OUTPUT_VISIBILITY);
}

/**
 * @param {unknown} raw
 * @returns {OutputVisibilityKey[]}
 */
export function getEnabledOutputVisibilityKeys(raw) {
  const visibility = resolveOutputVisibility(raw);
  return OUTPUT_VISIBILITY_FLAGS
    .filter((flag) => visibility[flag.key])
    .map((flag) => flag.key);
}

/**
 * @param {string} key
 * @returns {OutputVisibilityFlagDefinition | null}
 */
export function getOutputVisibilityFlagDefinition(key) {
  const normalizedKey = key.trim().toLowerCase();
  return OUTPUT_VISIBILITY_FLAGS.find((flag) => flag.key.toLowerCase() === normalizedKey) ?? null;
}

/**
 * @param {unknown} raw
 * @param {OutputVisibilityKey} key
 * @param {boolean} enabled
 * @returns {OutputVisibilityOverrides}
 */
export function setOutputVisibilityOverride(raw, key, enabled) {
  const overrides = normalizeOutputVisibility(raw);
  if (enabled === DEFAULT_OUTPUT_VISIBILITY[key]) {
    delete overrides[key];
  } else {
    overrides[key] = enabled;
  }
  return overrides;
}

/**
 * Normalize persisted overrides into the current compact DB shape.
 * @param {unknown} raw
 * @returns {OutputVisibilityOverrides}
 */
export function compactOutputVisibilityOverrides(raw) {
  return buildOutputVisibilityOverrides(getEnabledOutputVisibilityKeys(raw));
}

/**
 * Build overrides from the full set of enabled keys.
 * @param {readonly OutputVisibilityKey[]} enabledKeys
 * @returns {OutputVisibilityOverrides}
 */
export function buildOutputVisibilityOverrides(enabledKeys) {
  const enabledSet = new Set(enabledKeys);
  /** @type {OutputVisibilityOverrides} */
  const overrides = {};

  for (const flag of OUTPUT_VISIBILITY_FLAGS) {
    const enabled = enabledSet.has(flag.key);
    if (enabled !== DEFAULT_OUTPUT_VISIBILITY[flag.key]) {
      overrides[flag.key] = enabled;
    }
  }

  return overrides;
}

/**
 * Toggle a subset of keys relative to the current resolved visibility.
 * @param {unknown} raw
 * @param {readonly OutputVisibilityKey[]} toggledKeys
 * @returns {OutputVisibilityOverrides}
 */
export function toggleOutputVisibilityOverrides(raw, toggledKeys) {
  const current = resolveOutputVisibility(raw);
  const toggledSet = new Set(toggledKeys);
  /** @type {OutputVisibilityKey[]} */
  const enabledKeys = [];

  for (const flag of OUTPUT_VISIBILITY_FLAGS) {
    const enabled = toggledSet.has(flag.key) ? !current[flag.key] : current[flag.key];
    if (enabled) {
      enabledKeys.push(flag.key);
    }
  }

  return buildOutputVisibilityOverrides(enabledKeys);
}
