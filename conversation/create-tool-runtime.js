/**
 * Create a harness-facing tool runtime from action-layer primitives.
 */

/**
 * Convert an action object into the smaller tool descriptor shape exposed to harnesses.
 * @param {Action} action
 * @returns {ToolDescriptor}
 */
function toToolDescriptor(action) {
  return {
    name: action.name,
    description: action.description,
    instructions: action.instructions,
    scope: action.scope,
    parameters: action.parameters,
    permissions: action.permissions,
    formatToolCall: action.formatToolCall,
  };
}

/**
 * Create the tool runtime used by harnesses.
 * @param {{
 *   tools: Action[],
 *   resolveTool: (name: string) => Promise<AppAction | null>,
 *   executeActionFn: typeof import("../actions.js").executeAction,
 *   llmClient: LlmClient,
 * }} input
 * @returns {ToolRuntime}
 */
export function createToolRuntime({ tools, resolveTool, executeActionFn, llmClient }) {
  const toolList = tools.map(toToolDescriptor);

  return {
    listTools: () => toolList,
    getTool: async (name) => {
      const listedTool = toolList.find((tool) => tool.name === name);
      if (listedTool) {
        return listedTool;
      }

      const resolvedTool = await resolveTool(name);
      return resolvedTool ? toToolDescriptor(resolvedTool) : null;
    },
    executeTool: (toolName, context, params, options = {}) => {
      return executeActionFn(toolName, context, params, {
        toolCallId: options.toolCallId ?? null,
        actionResolver: resolveTool,
        llmClient,
        agentDepth: options.agentDepth,
      });
    },
  };
}
