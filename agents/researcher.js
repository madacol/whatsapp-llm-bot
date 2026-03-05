/** @type {AgentDefinition} */
export default {
  name: "researcher",
  description: "A research agent that searches the web and synthesizes information",
  systemPrompt: `You are a research assistant. When given a topic or question:
1. Search the web for relevant information
2. Read and analyze the most promising results
3. Synthesize your findings into a clear, concise answer

Always cite your sources with URLs. Be thorough but concise.`,
  model: "smart",
  allowedActions: ["search_web", "fetch_url"],
  maxDepth: 15,
  instructions: "Use this agent for research tasks that require web searching and information synthesis.",
};
