import { getAgent, getAgents } from "../../../agents.js";
import { runAgent } from "../../../agent-runner.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "delegate_to_agent",
  description: "Delegate a task to a specialized agent. The agent runs autonomously with its own tools and returns the result. Available agents are listed in the instructions.",
  parameters: {
    type: "object",
    properties: {
      agent_name: {
        type: "string",
        description: "Name of the agent to delegate to. The action will return an error with the list of available agents if the name is invalid.",
      },
      task: {
        type: "string",
        description: "Clear description of the task for the agent to perform",
      },
    },
    required: ["agent_name", "task"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useLlm: true,
  },
  /** @param {{agent_name?: string, task?: string}} params */
  formatToolCall: ({ agent_name, task }) =>
    `Delegating to ${agent_name}: ${task?.slice(0, 60)}${(task?.length ?? 0) > 60 ? "..." : ""}`,
  instructions: "Pass the agent_name exactly as shown. Provide a detailed task description so the agent has full context.",
  /**
   * @param {ExtendedActionContext<{autoExecute: true, autoContinue: true, useLlm: true}>} context
   * @param {{ agent_name: string, task: string }} params
   */
  action_fn: async function (context, params) {
    const agent = await getAgent(params.agent_name);
    if (!agent) {
      const agents = await getAgents();
      const available = agents.map(a => a.name).join(", ") || "none";
      return `Agent "${params.agent_name}" not found. Available agents: ${available}`;
    }

    /** @type {Message[]} */
    const messages = [
      { role: "user", content: [{ type: "text", text: params.task }] },
    ];

    const result = await runAgent({
      agent,
      messages,
      llmClient: context.llmClient,
      agentDepth: context.agentDepth ?? 0,
      chatId: context.chatId,
      senderIds: context.senderIds,
      parentToolCallId: context.toolCallId ?? undefined,
    });

    return result.response.length > 0
      ? result.response
      : "Agent completed with no response.";
  },
});
