import { createLogger } from "./logger.js";

const log = createLogger("agent-io");

export const MAX_TOOL_CALL_DEPTH = 10;

/** @type {Required<AgentIOHooks>} */
export const NO_OP_HOOKS = {
  onReasoning: async () => {},
  onLlmResponse: async () => {},
  onAskUser: async () => "",
  onToolCall: async () => {},
  onToolComplete: async () => {},
  onToolResult: async (_blocks, _name, _perms) => {},
  onToolError: async () => {},
  onPlan: async () => {},
  onFileChange: async () => {},
  onContinuePrompt: async () => true,
  onDepthLimit: async () => false,
  onUsage: async () => {},
  onRuntimeEvent: async () => {},
};

/**
 * Parse tool call arguments from JSON string, with error fallback.
 * @param {string} argsString
 * @returns {Record<string, unknown>}
 */
export function parseToolArgs(argsString) {
  try {
    return JSON.parse(argsString || "{}");
  } catch {
    log.error("Failed to parse tool call arguments:", argsString);
    return {};
  }
}
