import { buildToolPresentation } from "../tool-presentation-model.js";
import { formatToolPresentationInspect, formatToolPresentationSummary } from "#presentation/whatsapp";
import { createToolMessage, registerInspectHandler } from "../utils.js";

/**
 * @typedef {{
 *   handle: MessageHandle,
 *   presentation: import("../tool-presentation-model.js").ToolPresentation,
 * }} PendingSyntheticTool
 */

/**
 * @param {{
 *   onToolCall: Required<Pick<AgentIOHooks, "onToolCall">>["onToolCall"],
 *   cwd: string | null,
 * }} input
 * @returns {{
 *   handleAssistantText: (text: string) => Promise<boolean>,
 *   handleCommandCompletion: (event: { output?: string }) => void,
 * }}
 */
export function createCodexSyntheticToolAdapter({ onToolCall, cwd }) {
  /** @type {PendingSyntheticTool[]} */
  const pendingWriteStdin = [];

  return {
    handleAssistantText,
    handleCommandCompletion,
  };

  /**
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function handleAssistantText(text) {
    const syntheticTool = extractSyntheticCodexTool(text);
    if (!syntheticTool) {
      return isInternalToolNarration(text);
    }

    const toolCall = {
      id: `codex-synthetic:${syntheticTool}:${pendingWriteStdin.length + 1}`,
      name: syntheticTool,
      arguments: "{}",
    };
      const handle = await onToolCall(toolCall);
      if (handle && syntheticTool === "write_stdin") {
        pendingWriteStdin.push({
          handle,
          presentation: buildToolPresentation(syntheticTool, {}, undefined, cwd, undefined),
        });
      }
      return true;
  }

  /**
   * @param {{ output?: string }} event
   * @returns {void}
   */
  function handleCommandCompletion(event) {
    if (pendingWriteStdin.length === 0) {
      return;
    }

    const synthetic = pendingWriteStdin.shift();
    if (!synthetic) {
      return;
    }

    registerInspectHandler(
      synthetic.handle,
      formatToolPresentationSummary(synthetic.presentation),
      createToolMessage(`codex-synthetic:${synthetic.presentation.toolName}`, event.output ?? ""),
      synthetic.presentation.toolName,
      formatToolPresentationInspect(synthetic.presentation, event.output ?? "") ?? undefined,
    );
  }
}

/**
 * @param {string} text
 * @returns {"write_stdin" | null}
 */
function extractSyntheticCodexTool(text) {
  const match = text.match(/^Using `([^`]+)`/);
  if (!match) {
    return null;
  }
  switch (match[1]) {
    case "write_stdin":
      return "write_stdin";
    default:
      return null;
  }
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isInternalToolNarration(text) {
  const trimmed = text.trim();
  return /^Using (?:the )?`[^`]+`(?: tool)?\b/i.test(trimmed)
    || /^Using the [A-Za-z0-9_-]+ tool\b/i.test(trimmed);
}
