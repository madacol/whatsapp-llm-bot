import { listMemories, deleteMemory, findMemories } from "../../../memory.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "memories",
  command: "memories",
  description:
    "List, search, or delete saved memories for this chat. " +
    "Usage: !memories (list all), !memories search <query>, !memories delete <id>",
  parameters: {
    type: "object",
    properties: {
      subcommand: {
        type: "string",
        enum: ["list", "delete", "search"],
        description: "The subcommand to run (default: list)",
      },
      args: {
        type: "string",
        description: "Arguments for the subcommand (memory id for delete, query for search)",
      },
    },
  },
  formatToolCall: ({ subcommand, args }) => {
    if (subcommand === "delete") return `Deleting memory #${args ?? ""}`;
    if (subcommand === "search") return `Searching memories: "${args ?? ""}"`;
    return "Listing memories";
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
    useLlm: true,
  },
  action_fn: async function ({ chatId, rootDb, llmClient }, params) {
    const subcommand = params.subcommand || "list";

    switch (subcommand) {
      case "list": {
        const memories = await listMemories(rootDb, chatId);
        if (memories.length === 0) {
          return "No memories saved for this chat.";
        }
        const lines = memories.map(m => {
          const time = m.created_at instanceof Date
            ? m.created_at.toISOString().slice(0, 10)
            : String(m.created_at).slice(0, 10);
          return `*#${m.id}* [${time}] ${m.content}`;
        });
        return `📝 *Saved memories (${memories.length}):*\n\n${lines.join("\n")}`;
      }

      case "delete": {
        const idStr = params.args?.trim();
        const id = Number(idStr);
        if (!idStr || isNaN(id) || !Number.isInteger(id)) {
          return "Invalid memory ID. Usage: !memories delete <id>";
        }
        const deleted = await deleteMemory(rootDb, chatId, id);
        if (!deleted) {
          return `Memory #${id} not found in this chat.`;
        }
        return `Memory #${id} deleted.`;
      }

      case "search": {
        const query = params.args?.trim();
        if (!query) {
          return "Please provide a search query. Usage: !memories search <query>";
        }
        const results = await findMemories(rootDb, llmClient, chatId, query, { minSimilarity: 0 });
        if (results.length === 0) {
          return "No memories found matching your query.";
        }
        const lines = results.map(m => {
          const time = m.created_at instanceof Date
            ? m.created_at.toISOString().slice(0, 10)
            : String(m.created_at).slice(0, 10);
          return `*#${m.id}* [${time}] ${m.content}`;
        });
        return `🔍 *Found ${results.length} memories:*\n\n${lines.join("\n")}`;
      }

      default:
        return `Unknown subcommand: ${subcommand}. Use: list, delete, search`;
    }
  },
});
