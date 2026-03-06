import config from "../../../config.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "search_web",
  command: "search",
  description:
    "Search the web for current information, news, facts, or any topic. Returns titles, URLs, and descriptions of top results.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: {
        type: "number",
        description: "Number of results to return (1-10, default 5)",
      },
    },
    required: ["query"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /** @param {{query?: string}} params */
  formatToolCall: ({ query }) => `Searching "${query}"`,
  /**
   * @param {ActionContext} _context
   * @param {{ query: string, count?: number }} params
   */
  action_fn: async function (_context, params) {
    const apiKey = config.brave_api_key;
    if (!apiKey) {
      return "Error: BRAVE_API_KEY is not configured. Set the BRAVE_API_KEY environment variable.";
    }

    const count = Math.max(1, Math.min(10, params.count ?? 5));

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=${count}`;
    const response = await fetch(url, {
      headers: { "X-Subscription-Token": apiKey },
    });

    if (!response.ok) {
      return `Error: Brave Search API returned status ${response.status}`;
    }

    /** @type {{ web?: { results?: Array<{ title: string, url: string, description: string }> } }} */
    const data = await response.json();
    const results = data.web?.results ?? [];

    if (results.length === 0) {
      return "No results found.";
    }

    return results
      .map((r) => `**${r.title}**\n${r.url}\n${r.description}`)
      .join("\n\n");
  },
});
