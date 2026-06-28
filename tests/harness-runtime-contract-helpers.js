/**
 * @typedef {Pick<AgentIOHooks, "onToolCall" | "onToolError" | "onFileChange" | "onLlmResponse" | "onUsage">} RuntimeHookRecorderHooks
 */

/**
 * @returns {{
 *   hooks: RuntimeHookRecorderHooks,
 *   toolCalls: Array<LlmChatResponse["toolCalls"][0]>,
 *   toolErrors: string[],
 *   fileChanges: Array<Parameters<Required<AgentIOHooks>["onFileChange"]>[0]>,
 *   responses: string[],
 *   usages: Array<{ cost: string, tokens: UsageTokens }>,
 * }}
 */
export function createRuntimeHookRecorder() {
  /** @type {Array<LlmChatResponse["toolCalls"][0]>} */
  const toolCalls = [];
  /** @type {string[]} */
  const toolErrors = [];
  /** @type {Array<Parameters<Required<AgentIOHooks>["onFileChange"]>[0]>} */
  const fileChanges = [];
  /** @type {string[]} */
  const responses = [];
  /** @type {Array<{ cost: string, tokens: UsageTokens }>} */
  const usages = [];

  return {
    hooks: {
      onToolCall: async (toolCall) => {
        toolCalls.push(toolCall);
      },
      onToolError: async (message) => {
        toolErrors.push(message);
      },
      onFileChange: async (event) => {
        fileChanges.push(event);
      },
      onLlmResponse: async (message) => {
        responses.push(message);
      },
      onUsage: async (cost, tokens) => {
        usages.push({ cost, tokens });
      },
    },
    toolCalls,
    toolErrors,
    fileChanges,
    responses,
    usages,
  };
}
