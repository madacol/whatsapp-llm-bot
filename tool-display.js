/**
 * Compatibility exports for tool presentation.
 *
 * The semantic model lives in `tool-presentation-model.js`. WhatsApp-specific
 * display and inspect policy lives in `presentation/whatsapp.js`.
 */

import { parseToolArgs } from "#harnesses";
import {
  buildToolPresentation,
  formatActivitySummary,
  shortenPath,
} from "./tool-presentation-model.js";
import {
  formatBashCommand,
  formatPlanPresentationText,
  formatToolPresentationDisplay,
  formatToolPresentationInspect,
  formatToolPresentationSummary,
  langFromPath,
} from "./presentation/whatsapp.js";

/**
 * Tool names that map to the shared semantic SDK-style presentation layer.
 * @type {Set<string>}
 */
const SDK_PRESENTATION_TOOLS = new Set([
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "search_query",
  "image_query",
  "open",
  "find",
  "time",
  "weather",
  "finance",
  "sports",
  "update_plan",
  "exec_command",
  "spawn_agent",
  "send_input",
  "wait_agent",
  "resume_agent",
  "close_agent",
  "parallel",
  "write_stdin",
]);

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} [cwd]
 * @returns {string | null}
 */
export function formatSdkToolCall(name, args, cwd) {
  if (!SDK_PRESENTATION_TOOLS.has(name)) {
    return null;
  }
  return formatToolPresentationSummary(buildToolPresentation(name, args, undefined, cwd, undefined));
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | undefined} output
 * @returns {string | null}
 */
export function formatToolInspectBody(name, args, output) {
  return formatToolPresentationInspect(
    buildToolPresentation(name, args, undefined, undefined, undefined),
    output,
  );
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {((params: Record<string, unknown>) => string) | undefined} formatToolCall
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string; startLine?: number } | undefined} context
 * @returns {string}
 */
export function getToolCallSummary(name, args, formatToolCall, cwd, context) {
  return formatToolPresentationSummary(buildToolPresentation(name, args, formatToolCall, cwd, context));
}

/**
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {((params: Record<string, unknown>) => string) | undefined} [actionFormatter]
 * @param {string | null | undefined} [cwd]
 * @param {{ oldContent?: string; startLine?: number } | undefined} [context]
 * @returns {SendContent | null}
 */
export function formatToolCallDisplay(toolCall, actionFormatter, cwd, context) {
  const args = parseToolArgs(toolCall.arguments);
  return formatToolPresentationDisplay(
    buildToolPresentation(toolCall.name, args, actionFormatter, cwd, context),
  );
}

export {
  buildToolPresentation,
  formatActivitySummary,
  formatBashCommand,
  formatPlanPresentationText,
  formatToolPresentationDisplay,
  formatToolPresentationInspect,
  formatToolPresentationSummary,
  langFromPath,
  shortenPath,
};
