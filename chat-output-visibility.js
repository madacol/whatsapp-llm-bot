/**
 * Shared semantics for WhatsApp-configurable side-channel presentation.
 */

/**
 * @typedef {"fullDetails" | "indicatorInspectable" | "pinnedIndicator" | "hidden"} TextPresentationMode
 * @typedef {"shown" | "hidden"} BinaryPresentationMode
 * @typedef {"shown" | "pinnedCurrentStep" | "hidden"} PlanPresentationMode
 * @typedef {"shown" | "pinned" | "hidden"} UsagePresentationMode
 * @typedef {"on" | "off"} TogglePresentationMode
 * @typedef {"on" | "pinned" | "off"} MiddleAssistantMessagesPresentationMode
 * @typedef {"reasoning" | "tools" | "plans" | "fileChanges" | "snapshots" | "subagents" | "usage" | "transcription" | "middleAssistantMessages"} OutputPresentationKey
 *
 * @typedef {{
 *   reasoning?: TextPresentationMode;
 *   tools?: TextPresentationMode;
 *   plans?: PlanPresentationMode;
 *   fileChanges?: BinaryPresentationMode;
 *   snapshots?: TogglePresentationMode;
 *   subagents?: BinaryPresentationMode;
 *   usage?: UsagePresentationMode;
 *   transcription?: TextPresentationMode;
 *   middleAssistantMessages?: MiddleAssistantMessagesPresentationMode;
 * }} OutputVisibilityOverrides
 *
 * @typedef {{
 *   reasoning: TextPresentationMode;
 *   tools: TextPresentationMode;
 *   plans: PlanPresentationMode;
 *   fileChanges: BinaryPresentationMode;
 *   snapshots: TogglePresentationMode;
 *   subagents: BinaryPresentationMode;
 *   usage: UsagePresentationMode;
 *   transcription: TextPresentationMode;
 *   middleAssistantMessages: MiddleAssistantMessagesPresentationMode;
 * }} OutputVisibility
 *
 * @typedef {{
 *   key: OutputPresentationKey;
 *   label: string;
 *   description: string;
 *   defaultValue: string;
 *   options: readonly string[];
 *   aliases?: readonly string[];
 * }} OutputPresentationSettingDefinition
 *
 * @typedef {{
 *   key: string;
 *   label: string;
 *   description: string;
 *   overrides: OutputVisibilityOverrides;
 *   aliases?: readonly string[];
 * }} OutputPresentationPresetDefinition
 */

/** @type {readonly TextPresentationMode[]} */
export const TEXT_PRESENTATION_OPTIONS = Object.freeze([
  "fullDetails",
  "indicatorInspectable",
  "pinnedIndicator",
  "hidden",
]);

/** @type {readonly OutputPresentationSettingDefinition[]} */
export const OUTPUT_PRESENTATION_SETTINGS = Object.freeze([
  {
    key: "reasoning",
    label: "reasoning",
    description: "Reasoning traces.",
    defaultValue: "indicatorInspectable",
    options: TEXT_PRESENTATION_OPTIONS,
  },
  {
    key: "tools",
    label: "tools",
    description: "Tool and command lifecycle, output, and failures.",
    defaultValue: "indicatorInspectable",
    options: TEXT_PRESENTATION_OPTIONS,
  },
  {
    key: "plans",
    label: "plans",
    description: "Agent plan and checklist updates.",
    defaultValue: "shown",
    options: ["shown", "pinnedCurrentStep", "hidden"],
  },
  {
    key: "fileChanges",
    label: "file changes",
    description: "Explicit file edit/change presentation.",
    defaultValue: "shown",
    options: ["shown", "hidden"],
    aliases: ["file-changes", "file_changes"],
  },
  {
    key: "snapshots",
    label: "snapshots",
    description: "Unreported snapshot file-change detection and presentation.",
    defaultValue: "on",
    options: ["on", "off"],
  },
  {
    key: "subagents",
    label: "subagents",
    description: "Subagent text output.",
    defaultValue: "shown",
    options: ["shown", "hidden"],
  },
  {
    key: "usage",
    label: "usage",
    description: "Token and cost summaries.",
    defaultValue: "shown",
    options: ["shown", "pinned", "hidden"],
  },
  {
    key: "transcription",
    label: "transcription",
    description: "Audio transcription status and transcript presentation.",
    defaultValue: "indicatorInspectable",
    options: TEXT_PRESENTATION_OPTIONS,
  },
  {
    key: "middleAssistantMessages",
    label: "middle assistant messages",
    description: "Assistant text emitted before the final answer.",
    defaultValue: "on",
    options: ["on", "pinned", "off"],
    aliases: ["middle-assistant-messages", "middle_assistant_messages", "assistant-updates", "assistantUpdates"],
  },
]);

/** @type {OutputVisibility} */
export const DEFAULT_OUTPUT_VISIBILITY = Object.freeze({
  reasoning: "indicatorInspectable",
  tools: "indicatorInspectable",
  plans: "shown",
  fileChanges: "shown",
  snapshots: "on",
  subagents: "shown",
  usage: "shown",
  transcription: "indicatorInspectable",
  middleAssistantMessages: "on",
});

/** @type {readonly OutputPresentationPresetDefinition[]} */
export const OUTPUT_PRESENTATION_PRESETS = Object.freeze([
  {
    key: "default",
    label: "default",
    description: "Balanced current WhatsApp presentation.",
    overrides: {},
    aliases: ["balanced", "reset"],
  },
  {
    key: "compact",
    label: "compact",
    description: "Move progress into pinned status and suppress optional mid-turn noise.",
    overrides: {
      reasoning: "pinnedIndicator",
      tools: "pinnedIndicator",
      plans: "pinnedCurrentStep",
      snapshots: "off",
      usage: "pinned",
      transcription: "pinnedIndicator",
      middleAssistantMessages: "off",
    },
    aliases: ["quiet"],
  },
  {
    key: "minimal",
    label: "minimal",
    description: "Hide side-channel output and keep normal assistant answers.",
    overrides: {
      reasoning: "hidden",
      tools: "hidden",
      plans: "hidden",
      fileChanges: "hidden",
      snapshots: "off",
      subagents: "hidden",
      usage: "hidden",
      transcription: "pinnedIndicator",
      middleAssistantMessages: "pinned",
    },
    aliases: ["silent"],
  },
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeToken(value) {
  return value.trim().toLowerCase().replace(/[\s_+-]+/g, "");
}

/**
 * @param {string} key
 * @returns {OutputPresentationSettingDefinition | null}
 */
export function getOutputPresentationSettingDefinition(key) {
  const normalized = normalizeToken(key);
  return OUTPUT_PRESENTATION_SETTINGS.find((setting) =>
    normalizeToken(setting.key) === normalized
    || normalizeToken(setting.label) === normalized
    || (setting.aliases ?? []).some((alias) => normalizeToken(alias) === normalized)) ?? null;
}

/**
 * @param {string} key
 * @returns {OutputPresentationPresetDefinition | null}
 */
export function getOutputPresentationPresetDefinition(key) {
  const normalized = normalizeToken(key);
  return OUTPUT_PRESENTATION_PRESETS.find((preset) =>
    normalizeToken(preset.key) === normalized
    || normalizeToken(preset.label) === normalized
    || (preset.aliases ?? []).some((alias) => normalizeToken(alias) === normalized)) ?? null;
}

/**
 * @param {OutputPresentationKey} key
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeOutputPresentationOption(key, raw) {
  const normalized = normalizeToken(raw);
  if (key === "reasoning" || key === "tools" || key === "transcription") {
    if (["fulldetails", "full", "details", "detail"].includes(normalized)) return "fullDetails";
    if (["indicatorinspectable", "inspectable", "inspect", "message", "dedicated", "on", "shown", "true"].includes(normalized)) return "indicatorInspectable";
    if (["indicatorinpinnedstatus", "pinnedindicator", "pinned", "status"].includes(normalized)) return "pinnedIndicator";
    if (["hidden", "hide", "off", "none", "false"].includes(normalized)) return "hidden";
    return null;
  }
  if (key === "plans") {
    if (["shown", "show", "on", "message"].includes(normalized)) return "shown";
    if (["pinnedcurrentstep", "currentstepinpinnedstatus", "currentstep", "pinned", "status"].includes(normalized)) return "pinnedCurrentStep";
    if (["hidden", "hide", "off", "none"].includes(normalized)) return "hidden";
    return null;
  }
  if (key === "usage") {
    if (["shown", "show", "on", "message"].includes(normalized)) return "shown";
    if (["pinned", "status", "pinnedstatus"].includes(normalized)) return "pinned";
    if (["hidden", "hide", "off", "none"].includes(normalized)) return "hidden";
    return null;
  }
  if (key === "snapshots") {
    if (["on", "shown", "show", "enabled", "true"].includes(normalized)) return "on";
    if (["off", "hidden", "hide", "disabled", "false", "none"].includes(normalized)) return "off";
    return null;
  }
  if (key === "middleAssistantMessages") {
    if (["on", "shown", "show", "enabled", "true", "message", "messages"].includes(normalized)) return "on";
    if (["pinned", "status", "pinnedstatus", "indicatorinpinnedstatus", "pinnedindicator"].includes(normalized)) return "pinned";
    if (["off", "hidden", "hide", "disabled", "false", "none"].includes(normalized)) return "off";
    return null;
  }
  if (key === "fileChanges" || key === "subagents") {
    if (["shown", "show", "on", "enabled", "true"].includes(normalized)) return "shown";
    if (["hidden", "hide", "off", "disabled", "false", "none"].includes(normalized)) return "hidden";
    return null;
  }
  return null;
}

/**
 * @param {OutputPresentationKey} key
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeKnownOutputPresentationValue(key, value) {
  if (typeof value !== "string") {
    return null;
  }
  return normalizeOutputPresentationOption(key, value);
}

/**
 * @param {OutputVisibilityOverrides} overrides
 * @param {OutputPresentationKey} key
 * @param {string} value
 * @returns {void}
 */
function assignPresentationOverride(overrides, key, value) {
  switch (key) {
    case "reasoning":
      overrides.reasoning = /** @type {TextPresentationMode} */ (value);
      break;
    case "tools":
      overrides.tools = /** @type {TextPresentationMode} */ (value);
      break;
    case "plans":
      overrides.plans = /** @type {PlanPresentationMode} */ (value);
      break;
    case "fileChanges":
      overrides.fileChanges = /** @type {BinaryPresentationMode} */ (value);
      break;
    case "snapshots":
      overrides.snapshots = /** @type {TogglePresentationMode} */ (value);
      break;
    case "subagents":
      overrides.subagents = /** @type {BinaryPresentationMode} */ (value);
      break;
    case "usage":
      overrides.usage = /** @type {UsagePresentationMode} */ (value);
      break;
    case "transcription":
      overrides.transcription = /** @type {TextPresentationMode} */ (value);
      break;
    case "middleAssistantMessages":
      overrides.middleAssistantMessages = /** @type {MiddleAssistantMessagesPresentationMode} */ (value);
      break;
  }
}

/**
 * @param {OutputVisibilityOverrides} overrides
 * @param {OutputPresentationKey} key
 * @returns {void}
 */
function deletePresentationOverride(overrides, key) {
  delete overrides[key];
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

  for (const setting of OUTPUT_PRESENTATION_SETTINGS) {
    const value = normalizeKnownOutputPresentationValue(setting.key, raw[setting.key]);
    if (value) {
      assignPresentationOverride(normalized, setting.key, value);
    }
  }

  return compactOutputVisibilityOverrides(normalized);
}

/**
 * @param {unknown} raw
 * @returns {raw is Record<string, unknown>}
 */
export function hasLegacyOutputVisibilityOverrides(raw) {
  if (!isRecord(raw)) {
    return false;
  }
  return typeof raw.thinking === "boolean"
    || typeof raw.changes === "boolean"
    || typeof raw.toolStatus === "boolean"
    || typeof raw.toolDetails === "boolean"
    || typeof raw.tools === "boolean"
    || typeof raw.usage === "boolean"
    || typeof raw.subagents === "boolean";
}

/**
 * Translate legacy persisted visibility flags into the new category-owned
 * contract. Runtime normalization intentionally does not call this.
 * @param {unknown} raw
 * @returns {OutputVisibilityOverrides}
 */
export function migrateLegacyOutputVisibilityOverrides(raw) {
  if (!isRecord(raw)) {
    return {};
  }
  /** @type {OutputVisibilityOverrides} */
  const migrated = normalizeOutputVisibility(raw);
  if (typeof raw.thinking === "boolean" && migrated.reasoning === undefined) {
    migrated.reasoning = raw.thinking ? "indicatorInspectable" : "hidden";
  }
  if (migrated.tools === undefined) {
    if (typeof raw.tools === "boolean") {
      migrated.tools = raw.tools ? "indicatorInspectable" : "pinnedIndicator";
    } else if (raw.toolDetails === true) {
      migrated.tools = "fullDetails";
    } else if (typeof raw.toolStatus === "boolean") {
      migrated.tools = raw.toolStatus ? "pinnedIndicator" : "indicatorInspectable";
    }
  }
  if (typeof raw.changes === "boolean" && migrated.fileChanges === undefined) {
    migrated.fileChanges = raw.changes ? "shown" : "hidden";
  }
  if (typeof raw.subagents === "boolean" && migrated.subagents === undefined) {
    migrated.subagents = raw.subagents ? "shown" : "hidden";
  }
  if (typeof raw.usage === "boolean" && migrated.usage === undefined) {
    migrated.usage = raw.usage ? "shown" : "hidden";
  }
  return compactOutputVisibilityOverrides(migrated);
}

/**
 * @param {OutputVisibilityOverrides} raw
 * @returns {OutputVisibilityOverrides}
 */
export function compactOutputVisibilityOverrides(raw) {
  /** @type {OutputVisibilityOverrides} */
  const compacted = {};
  for (const setting of OUTPUT_PRESENTATION_SETTINGS) {
    const value = normalizeKnownOutputPresentationValue(setting.key, raw[setting.key]);
    if (value && value !== DEFAULT_OUTPUT_VISIBILITY[setting.key]) {
      assignPresentationOverride(compacted, setting.key, value);
    }
  }
  return compacted;
}

/**
 * @param {unknown} leftRaw
 * @param {unknown} rightRaw
 * @returns {boolean}
 */
function outputVisibilityOverridesEqual(leftRaw, rightRaw) {
  const left = normalizeOutputVisibility(leftRaw);
  const right = normalizeOutputVisibility(rightRaw);
  return OUTPUT_PRESENTATION_SETTINGS.every((setting) => left[setting.key] === right[setting.key]);
}

/**
 * @param {OutputPresentationPresetDefinition} preset
 * @returns {OutputVisibilityOverrides}
 */
export function buildOutputPresentationPresetOverrides(preset) {
  return compactOutputVisibilityOverrides(preset.overrides);
}

/**
 * @param {unknown} raw
 * @returns {OutputPresentationPresetDefinition | null}
 */
export function getOutputPresentationPresetForVisibility(raw) {
  return OUTPUT_PRESENTATION_PRESETS.find((preset) => outputVisibilityOverridesEqual(raw, preset.overrides)) ?? null;
}

/**
 * @param {unknown} raw
 * @returns {OutputVisibility}
 */
export function resolveOutputVisibility(raw) {
  const overrides = normalizeOutputVisibility(raw);
  const reasoning = overrides.reasoning ?? DEFAULT_OUTPUT_VISIBILITY.reasoning;
  const tools = typeof overrides.tools === "string" ? overrides.tools : DEFAULT_OUTPUT_VISIBILITY.tools;
  const plans = overrides.plans ?? DEFAULT_OUTPUT_VISIBILITY.plans;
  const fileChanges = overrides.fileChanges ?? DEFAULT_OUTPUT_VISIBILITY.fileChanges;
  const snapshots = overrides.snapshots ?? DEFAULT_OUTPUT_VISIBILITY.snapshots;
  const subagents = typeof overrides.subagents === "string" ? overrides.subagents : DEFAULT_OUTPUT_VISIBILITY.subagents;
  const usage = typeof overrides.usage === "string" ? overrides.usage : DEFAULT_OUTPUT_VISIBILITY.usage;
  const transcription = overrides.transcription ?? DEFAULT_OUTPUT_VISIBILITY.transcription;
  const middleAssistantMessages = overrides.middleAssistantMessages ?? DEFAULT_OUTPUT_VISIBILITY.middleAssistantMessages;
  return {
    reasoning,
    tools,
    plans,
    fileChanges,
    snapshots,
    subagents,
    usage,
    transcription,
    middleAssistantMessages,
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
export function formatOutputPresentationOption(value) {
  switch (value) {
    case "fullDetails":
      return "full details";
    case "indicatorInspectable":
      return "indicator + inspectable";
    case "pinnedIndicator":
      return "indicator in pinned status";
    case "pinnedCurrentStep":
      return "current step in pinned status";
    case "shown":
      return "shown";
    case "hidden":
      return "hidden";
    case "pinned":
      return "pinned status";
    case "on":
      return "on";
    case "off":
      return "off";
    default:
      return value;
  }
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function formatOutputVisibility(raw) {
  const visibility = resolveOutputVisibility(raw);
  return OUTPUT_PRESENTATION_SETTINGS
    .map((setting) => `${setting.label} ${formatOutputPresentationOption(visibility[setting.key])}`)
    .join(", ");
}

/**
 * @returns {string}
 */
export function formatOutputVisibilityDefault() {
  return formatOutputVisibility({});
}

/**
 * @param {unknown} raw
 * @param {OutputPresentationKey} key
 * @param {string} value
 * @returns {OutputVisibilityOverrides}
 */
export function setOutputPresentationOverride(raw, key, value) {
  const option = normalizeOutputPresentationOption(key, value);
  if (!option) {
    return normalizeOutputVisibility(raw);
  }
  const overrides = normalizeOutputVisibility(raw);
  if (option === DEFAULT_OUTPUT_VISIBILITY[key]) {
    deletePresentationOverride(overrides, key);
  } else {
    assignPresentationOverride(overrides, key, option);
  }
  return compactOutputVisibilityOverrides(overrides);
}

/**
 * @param {string} raw
 * @returns {{ key: OutputPresentationKey, option: string } | null}
 */
export function parseOutputPresentationSetting(raw) {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  for (let length = Math.min(4, parts.length - 1); length >= 1; length -= 1) {
    const keyText = parts.slice(0, length).join(" ");
    const setting = getOutputPresentationSettingDefinition(keyText);
    if (!setting) {
      continue;
    }
    const optionText = parts.slice(length).join(" ");
    const option = normalizeOutputPresentationOption(setting.key, optionText);
    if (option) {
      return { key: setting.key, option };
    }
  }
  return null;
}

/**
 * @param {OutputPresentationKey} key
 * @returns {string}
 */
export function getOutputPresentationLabel(key) {
  return getOutputPresentationSettingDefinition(key)?.label ?? key;
}
