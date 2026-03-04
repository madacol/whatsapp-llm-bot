import assert from "node:assert/strict";
import config from "../../../config.js";

export default [
async function test_search_returns_formatted_results(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = config.brave_api_key;
      try {
        config.brave_api_key = "test-key";
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
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
        })));
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
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: false,
          status: 500,
        })));
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
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url) => {
          capturedUrl = url;
          return {
            ok: true,
            json: async () => ({ web: { results: [] } }),
          };
        }));
        await action_fn({ log: async () => "" }, { query: "test", count: 50 });
        assert.ok(capturedUrl, "fetch should have been called");
        const parsedUrl = new URL(capturedUrl);
        assert.equal(parsedUrl.searchParams.get("count"), "10");
      } finally {
        globalThis.fetch = originalFetch;
        config.brave_api_key = savedKey;
      }
    },
];
