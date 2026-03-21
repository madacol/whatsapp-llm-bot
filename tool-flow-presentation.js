/**
 * Grouped tool-flow presentation helpers.
 */

import { formatToolPresentationSummary } from "./whatsapp/tool-presenter.js";
import { getToolFlowDescriptor } from "./tool-presentation-model.js";

/**
 * @typedef {{
 *   id: string,
 *   presentation: import("./tool-presentation-model.js").ToolPresentation,
 *   output?: string,
 * }} ToolFlowStep
 */

/**
 * @typedef {{
 *   title: string,
 *   steps: ToolFlowStep[],
 * }} ToolFlowState
 */

/**
 * @param {ToolFlowState} toolFlow
 * @returns {string}
 */
export function formatToolFlowSummary(toolFlow) {
  const parts = toolFlow.steps
    .map((step) => getToolFlowDescriptor(step.presentation)?.detail ?? null)
    .filter((part) => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? `*${toolFlow.title}*  ${parts.join(" -> ")}` : `*${toolFlow.title}*`;
}

/**
 * @param {ToolFlowState} toolFlow
 * @param {(presentation: import("./tool-presentation-model.js").ToolPresentation, output?: string) => string | null} formatInspect
 * @returns {string}
 */
export function formatToolFlowInspectText(toolFlow, formatInspect) {
  /** @type {string[]} */
  const sections = [];

  for (const step of toolFlow.steps) {
    sections.push(formatToolPresentationSummary(step.presentation));
    sections.push("");
    sections.push(formatInspect(step.presentation, step.output) ?? "_no output_");
    sections.push("");
  }

  while (sections.length > 0 && sections[sections.length - 1] === "") {
    sections.pop();
  }

  return sections.join("\n");
}
