/**
 * Shared semantic plan presentation and rendering helpers.
 */

import { formatPlanStatusToken, normalizePlanEntryStatus } from "./plan-status-formatting.js";

/**
 * @typedef {{
 *   text: string,
 *   status: "completed" | "in_progress" | "pending" | "unknown",
 * }} PlanEntry
 */

/**
 * @typedef {{
 *   kind: "plan",
 *   toolName: string,
 *   summary: string,
 *   explanation: string | null,
 *   entries: PlanEntry[],
 * }} PlanPresentation
 */

/**
 * @param {string} text
 * @returns {string}
 */
function shortenPlanSummaryText(text) {
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/**
 * @param {string | null} explanation
 * @param {PlanEntry[]} entries
 * @returns {string}
 */
function formatPlanSummary(explanation, entries) {
  const activeEntry = entries.find((entry) => entry.status === "in_progress");
  if (activeEntry) {
    return `*Plan*  _Working on: ${shortenPlanSummaryText(activeEntry.text)}_`;
  }

  const nextEntry = entries.find((entry) => entry.status === "pending");
  if (nextEntry) {
    return `*Plan*  _Next: ${shortenPlanSummaryText(nextEntry.text)}_`;
  }

  if (entries.length > 0 && entries.every((entry) => entry.status === "completed")) {
    return `*Plan*  _All ${entries.length} step${entries.length === 1 ? "" : "s"} completed_`;
  }

  if (entries.length > 0) {
    return `*Plan*  _${entries.length} step${entries.length === 1 ? "" : "s"}_`;
  }

  if (explanation) {
    return `*Plan*  _${shortenPlanSummaryText(explanation)}_`;
  }

  return "*Plan*";
}

export { normalizePlanEntryStatus } from "./plan-status-formatting.js";

/**
 * @param {{
 *   explanation?: string | null,
 *   entries?: PlanEntry[],
 * }} state
 * @returns {PlanPresentation}
 */
export function createPlanPresentationFromState(state) {
  const explanation = typeof state.explanation === "string" && state.explanation.trim()
    ? state.explanation.trim()
    : null;
  const entries = Array.isArray(state.entries)
    ? state.entries
      .filter((entry) => typeof entry?.text === "string" && entry.text.trim().length > 0)
      .map((entry) => ({
        text: entry.text.trim(),
        status: normalizePlanEntryStatus(entry.status),
      }))
    : [];
  return {
    kind: "plan",
    toolName: "update_plan",
    summary: formatPlanSummary(explanation, entries),
    explanation,
    entries,
  };
}

/**
 * @param {PlanPresentation} presentation
 * @returns {string[]}
 */
function buildPlanInspectLines(presentation) {
  /** @type {string[]} */
  const lines = [];
  if (presentation.explanation) {
    lines.push(`_${presentation.explanation}_`);
  }
  for (const entry of presentation.entries) {
    lines.push(`${formatPlanStatusToken(entry.status)} ${entry.text}`);
  }
  return lines;
}

/**
 * @param {PlanEntry} entry
 * @returns {string}
 */
function formatPlanMarkdownEntry(entry) {
  return entry.status === "unknown"
    ? `- ${entry.text}`
    : `- ${formatPlanStatusToken(entry.status)} ${entry.text}`;
}

/**
 * @param {PlanPresentation} presentation
 * @returns {string}
 */
export function formatPlanPresentationText(presentation) {
  const lines = [
    ...(presentation.explanation ? [`_${presentation.explanation}_`] : []),
    ...presentation.entries.map(formatPlanMarkdownEntry),
  ];
  const hasExplanation = typeof presentation.explanation === "string" && presentation.explanation.length > 0;
  const hasEntries = presentation.entries.length > 0;
  return lines.length > 0
    ? [
      "*Plan*",
      "",
      ...lines.slice(0, hasExplanation && hasEntries ? 1 : lines.length),
      ...(hasExplanation && hasEntries ? [""] : []),
      ...(hasExplanation && hasEntries ? lines.slice(1) : []),
    ].join("\n")
    : "*Plan*";
}

/**
 * @param {PlanPresentation} presentation
 * @param {string | undefined} output
 * @returns {string | null}
 */
export function formatPlanPresentationInspect(presentation, output) {
  const lines = buildPlanInspectLines(presentation);
  const trimmedOutput = typeof output === "string" ? output.trim() : "";
  const planText = presentation.entries.map((entry) => entry.text).join("\n");
  const includeOutput = trimmedOutput.length > 0 && trimmedOutput !== planText;
  if (lines.length === 0) {
    return includeOutput ? trimmedOutput : null;
  }
  return includeOutput ? [...lines, "", trimmedOutput].join("\n") : lines.join("\n");
}
