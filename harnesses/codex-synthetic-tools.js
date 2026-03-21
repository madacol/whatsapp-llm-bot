import { getToolCallSummary } from "../tool-display.js";
import { createToolMessage, registerInspectHandler } from "../utils.js";

/**
 * @typedef {{
 *   handle: MessageHandle,
 *   summary: string,
 *   toolName: string,
 * }} PendingSyntheticTool
 */

/**
 * @param {{
 *   onToolCall: Required<Pick<AgentIOHooks, "onToolCall">>["onToolCall"],
 *   cwd: string | null,
 * }} input
 * @returns {{
 *   handleAssistantText: (text: string) => Promise<void>,
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
   * @returns {Promise<void>}
   */
  async function handleAssistantText(text) {
    const syntheticTool = extractSyntheticCodexTool(text);
    if (!syntheticTool) {
      return;
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
        summary: getCodexToolSummary(syntheticTool, {}, cwd),
        toolName: syntheticTool,
      });
    }
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
      synthetic.summary,
      createToolMessage(`codex-synthetic:${synthetic.toolName}`, event.output ?? ""),
      synthetic.toolName,
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
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null} cwd
 * @returns {string}
 */
function getCodexToolSummary(name, args, cwd) {
  const summary = getToolCallSummary(name, args, undefined, cwd);
  return summary === name ? `*${name}*` : summary;
}
