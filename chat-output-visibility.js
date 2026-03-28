/**
 * Shared semantics for chat-configurable agent progress visibility.
 */

/**
 * @typedef {"commands" | "thinking" | "tools" | "changes"} OutputVisibilityKey
 *
 * @typedef {{
 *   commands?: boolean;
 *   thinking?: boolean;
 *   tools?: boolean;
 *   changes?: boolean;
 * }} OutputVisibilityOverrides
 *
 * @typedef {{
 *   commands: boolean;
 *   thinking: boolean;
 *   tools: boolean;
 *   changes: boolean;
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
    key: "commands",
    label: "commands",
    description: "Show command and tool-call progress such as shell commands and file reads.",
    defaultValue: true,
  },
  {
    key: "thinking",
    label: "thinking",
    description: "Show reasoning placeholders and inspectable thinking summaries when available.",
    defaultValue: false,
  },
  {
    key: "tools",
    label: "tools",
    description: "Show intermediate tool result messages while the agent works.",
    defaultValue: true,
  },
  {
    key: "changes",
    label: "changes",
    description: "Show file changes and diff-style output from edits.",
    defaultValue: true,
  },
]);

/** @type {ReadonlyMap<OutputVisibilityKey, OutputVisibilityFlagDefinition>} */
const OUTPUT_VISIBILITY_FLAG_MAP = new Map(
  OUTPUT_VISIBILITY_FLAGS.map((flag) => [flag.key, flag]),
);

/** @type {OutputVisibility} */
export const DEFAULT_OUTPUT_VISIBILITY = Object.freeze({
  commands: true,
  thinking: false,
  tools: true,
  changes: true,
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
  return OUTPUT_VISIBILITY_FLAG_MAP.has(/** @type {OutputVisibilityKey} */ (value));
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
  for (const flag of OUTPUT_VISIBILITY_FLAGS) {
    const value = raw[flag.key];
    if (typeof value === "boolean") {
      normalized[flag.key] = value;
    }
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
  if (!isOutputVisibilityKey(normalizedKey)) {
    return null;
  }
  return OUTPUT_VISIBILITY_FLAG_MAP.get(normalizedKey) ?? null;
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
