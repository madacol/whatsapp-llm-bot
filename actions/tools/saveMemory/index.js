import { saveMemory, findMemories } from "../../../memory.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "save_memory",
  description:
    "Save a note that helps you understand this user better so future responses " +
    "are faster and more accurate. Prioritize: corrections the user made, " +
    "preferred response styles, how they phrase recurring requests, implicit " +
    "preferences revealed over time, and context that resolves ambiguity " +
    '(e.g. "User prefers concise bullet points over long explanations", ' +
    '"When user asks about \'the project\' they mean the React dashboard", ' +
    '"User corrected: always use metric units, not imperial"). ' +
    "Skip trivia or small-talk facts unless they clearly help predict what " +
    "the user will need. " +
    "NEVER save a memory that restates or confirms something already present " +
    "in the recalled memories — only save genuinely new information.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "A concise note capturing a pattern, preference, or correction " +
            "that helps predict what the user wants " +
            '(e.g. "User always wants code examples in Python, not JS")',
      },
    },
    required: ["content"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
    useLlm: true,
  },
  /** @param {{content?: string}} params */
  formatToolCall: ({ content }) => `Remembering "${content}"`,
  action_fn: async function ({ chatId, rootDb, llmClient, confirm }, params) {
    const content = params.content?.trim();
    if (!content) {
      return "Cannot save empty content. Please provide a note to remember.";
    }

    const existing = await findMemories(rootDb, llmClient, chatId, content, {
      limit: 1,
      minSimilarity: 0.85,
    });
    if (existing.length > 0) {
      const match = existing[0];
      const confirmed = await confirm(
        `⚠️ *Similar memory exists* (id: ${match.id}, similarity: ${Number(match.similarity).toFixed(3)}):\n` +
        `"${match.content.slice(0, 200)}"\n\n` +
        `React 👍 to save anyway or 👎 to skip.`
      );
      if (!confirmed) {
        return `Skipped — user declined to save duplicate memory.`;
      }
    }

    const id = await saveMemory(rootDb, llmClient, chatId, content);
    return `Memory saved (id: ${id}).`;
  },
});
