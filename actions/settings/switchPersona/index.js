import { getAgents, getAgent } from "../../../agents.js";
import { getChatOrThrow } from "../../../store.js";
import { updateChatConfig } from "../../../chat-config.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "switch_persona",
  command: "persona",
  description: "Activate or deactivate an agent persona for this chat. The persona overrides the system prompt and optionally the model and available tools.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Agent persona name to activate, or 'off' to deactivate",
      },
    },
    required: [],
  },
  permissions: {
    autoExecute: true,
    requireAdmin: true,
    useRootDb: true,
  },
  /** @param {{name?: string}} params */
  formatToolCall: ({ name }) => name ? `Switching to "${name}"` : "Showing persona",
  /**
   * @param {ExtendedActionContext<{autoExecute: true, requireAdmin: true, useRootDb: true}>} context
   * @param {{ name?: string }} params
   */
  action_fn: async function (context, params) {
    const { rootDb, chatId } = context;
    const chat = await getChatOrThrow(rootDb, chatId);

    // No argument: show current persona + list available
    if (!params.name) {
      const agents = await getAgents();
      const current = chat.active_persona;
      const agentList = agents.length > 0
        ? agents.map((a) => `• *${a.name}* — ${a.description}`).join("\n")
        : "No agent definitions found in agents/ directory.";

      return `*Current persona:* ${current || "none"}\n\n*Available personas:*\n${agentList}\n\nUsage: \`!persona <name>\` or \`!persona off\``;
    }

    // Deactivate
    if (params.name === "off" || params.name === "none") {
      await updateChatConfig(chatId, (current) => ({ ...current, active_persona: null }), chat);
      return "Persona deactivated. Using default system prompt.";
    }

    // Activate
    const agent = await getAgent(params.name);
    if (!agent) {
      const agents = await getAgents();
      const available = agents.map((a) => a.name).join(", ") || "none";
      return `Agent "${params.name}" not found. Available: ${available}`;
    }

    await updateChatConfig(chatId, (current) => ({ ...current, active_persona: agent.name }), chat);

    return `Persona activated: *${agent.name}*\n${agent.description}`;
  },
});
