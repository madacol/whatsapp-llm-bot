/**
 * Agent runs now execute through ACP harnesses. App capabilities should be
 * represented as ACP tool calls by the provider boundary, not by the legacy
 * local action catalog.
 * @returns {ToolRuntime}
 */
export function createNoAgentToolRuntime() {
  return {
    listTools: () => [],
    getTool: async () => null,
    executeTool: async (toolName) => {
      throw new Error(`Tool "${toolName}" is not available in ACP agent runs.`);
    },
  };
}
