import { textUpdate } from "./outbound-events.js";

export const FAILURE_MARKER = "❌";

/**
 * @param {string} summary
 * @returns {string}
 */
export function formatFailedMessageSummary(summary) {
  return summary.startsWith(`${FAILURE_MARKER} `) ? summary : `${FAILURE_MARKER} ${summary}`;
}

/**
 * @param {ToolPresentation} presentation
 * @returns {MessageHandleUpdate}
 */
export function failedToolCallUpdate(presentation) {
  return textUpdate(formatFailedMessageSummary(presentation.summary));
}
