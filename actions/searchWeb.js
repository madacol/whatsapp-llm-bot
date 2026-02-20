import assert from "node:assert/strict";
import config from "../config.js";

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
  test_functions: [
    async function test_search_returns_formatted_results(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = config.brave_api_key;
      try {
        config.brave_api_key = "test-key";
        globalThis.fetch = /** @type {any} */ (async () => ({
          ok: true,
          json: async () => ({
            web: {
              results: [
                {
                  title: "Example Result",
                  url: "https://example.com",
                  description: "An example search result",
                },
                {
                  title: "Another Result",
                  url: "https://another.com",
                  description: "Another search result",
                },
              ],
            },
          }),
        }));
        const result = await action_fn(
          { log: async () => "" },
          { query: "test query" },
        );
        assert.ok(result.includes("Example Result"));
        assert.ok(result.includes("https://example.com"));
        assert.ok(result.includes("Another Result"));
        assert.ok(result.includes("https://another.com"));
      } finally {
        globalThis.fetch = originalFetch;
        config.brave_api_key = savedKey;
      }
    },

    async function test_search_missing_api_key(action_fn) {
      const savedKey = config.brave_api_key;
      try {
        config.brave_api_key = undefined;
        const result = await action_fn(
          { log: async () => "" },
          { query: "test" },
        );
        assert.ok(
          typeof result === "string" && result.toLowerCase().includes("brave_api_key"),
          `Expected error about missing BRAVE_API_KEY, got: ${result}`,
        );
      } finally {
        config.brave_api_key = savedKey;
      }
    },

    async function test_search_handles_api_error(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = config.brave_api_key;
      try {
        config.brave_api_key = "test-key";
        globalThis.fetch = /** @type {any} */ (async () => ({
          ok: false,
          status: 500,
        }));
        const result = await action_fn(
          { log: async () => "" },
          { query: "test" },
        );
        assert.ok(
          typeof result === "string" && result.includes("500"),
          `Expected error with status 500, got: ${result}`,
        );
      } finally {
        globalThis.fetch = originalFetch;
        config.brave_api_key = savedKey;
      }
    },

    async function test_search_clamps_count(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = config.brave_api_key;
      /** @type {string | undefined} */
      let capturedUrl;
      try {
        config.brave_api_key = "test-key";
        globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
          capturedUrl = url;
          return {
            ok: true,
            json: async () => ({ web: { results: [] } }),
          };
        });
        await action_fn({ log: async () => "" }, { query: "test", count: 50 });
        assert.ok(capturedUrl, "fetch should have been called");
        const parsedUrl = new URL(capturedUrl);
        assert.equal(parsedUrl.searchParams.get("count"), "10");
      } finally {
        globalThis.fetch = originalFetch;
        config.brave_api_key = savedKey;
      }
    },
  ],
  /**
   * @param {ActionContext} context
   * @param {{ query: string, count?: number }} params
   */
  action_fn: async function (context, params) {
    const apiKey = config.brave_api_key;
    if (!apiKey) {
      return "Error: BRAVE_API_KEY is not configured. Set the BRAVE_API_KEY environment variable.";
    }

    const count = Math.max(1, Math.min(10, params.count ?? 5));

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=${count}`;
    await context.log(`Searching the web for: ${params.query}`);

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
