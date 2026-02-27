import assert from "node:assert/strict";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export default /** @type {defineAction} */ ((x) => x)({
  name: "fetch_url",
  description:
    "Fetch a web page or resource by URL and return its content as readable text. Use this after search_web to read full pages.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch (must be http or https)" },
      max_length: {
        type: "number",
        description: "Maximum character length of returned content (1000-50000, default 16000)",
      },
    },
    required: ["url"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /** @param {{url?: string}} params */
  formatToolCall: ({ url }) => `Fetching "${url}"`,
  test_functions: [
    // 1. HTML with article content → returns markdown with title, no boilerplate
    async function test_html_returns_markdown_with_title(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          text: async () => `<!DOCTYPE html><html><head><title>Test Article</title></head><body>
            <nav>Site Nav</nav>
            <article><h1>Test Article</h1><p>This is the main article content that is long enough for readability to pick it up. It needs several sentences to be considered substantial content. Here is some more text to make it work properly with the readability algorithm.</p>
            <h2>Section Two</h2><p>More important content here that the reader should see.</p></article>
            <footer>Copyright 2024</footer>
          </body></html>`,
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://example.com/article" },
        );
        assert.equal(typeof result, "string");
        assert.ok(result.includes("Test Article"), `Expected title in result, got: ${result}`);
        assert.ok(result.includes("main article content"), `Expected article content, got: ${result}`);
        assert.ok(!result.includes("Site Nav"), `Expected no nav boilerplate, got: ${result}`);
        assert.ok(!result.includes("Copyright 2024"), `Expected no footer boilerplate, got: ${result}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 2. JSON response → returns pretty-printed JSON
    async function test_json_returns_pretty_printed(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        const jsonData = { name: "test", items: [1, 2, 3] };
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify(jsonData),
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://api.example.com/data" },
        );
        assert.equal(typeof result, "string");
        assert.equal(result, JSON.stringify(jsonData, null, 2));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 3. Plain text response → returns text directly
    async function test_plain_text_returned_directly(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/plain" }),
          text: async () => "Hello, this is plain text content.",
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://example.com/file.txt" },
        );
        assert.equal(result, "Hello, this is plain text content.");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 4. Invalid URL → error message
    async function test_invalid_url_returns_error(action_fn) {
      const result = await action_fn(
        { log: async () => "" },
        { url: "not-a-valid-url" },
      );
      assert.equal(typeof result, "string");
      assert.ok(result.toLowerCase().includes("invalid"), `Expected 'invalid' in error, got: ${result}`);
    },

    // 5. Non-HTTP protocol → error message
    async function test_non_http_protocol_returns_error(action_fn) {
      const result = await action_fn(
        { log: async () => "" },
        { url: "ftp://files.example.com/doc.pdf" },
      );
      assert.equal(typeof result, "string");
      assert.ok(result.toLowerCase().includes("http"), `Expected mention of http in error, got: ${result}`);
    },

    // 6. HTTP error status → includes status code
    async function test_http_error_includes_status(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: false,
          status: 404,
          headers: new Headers({ "content-type": "text/html" }),
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://example.com/missing" },
        );
        assert.equal(typeof result, "string");
        assert.ok(result.includes("404"), `Expected status 404 in error, got: ${result}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 7. Timeout → includes "timed out"
    async function test_timeout_returns_error(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => {
          const err = new DOMException("The operation was aborted", "AbortError");
          throw err;
        }));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://slow.example.com" },
        );
        assert.equal(typeof result, "string");
        assert.ok(result.toLowerCase().includes("timed out"), `Expected 'timed out' in error, got: ${result}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 8. Long content → truncated with indicator
    async function test_long_content_truncated(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        const longText = "A".repeat(20000);
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/plain" }),
          text: async () => longText,
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://example.com/long.txt" },
        );
        assert.equal(typeof result, "string");
        assert.ok(result.length <= 16100, `Expected truncation near 16000, got length: ${result.length}`);
        assert.ok(result.includes("[truncated]"), `Expected truncation indicator, got: ${result}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 9. Custom max_length respected
    async function test_custom_max_length(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        const longText = "B".repeat(5000);
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/plain" }),
          text: async () => longText,
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://example.com/data.txt", max_length: 2000 },
        );
        assert.equal(typeof result, "string");
        assert.ok(result.length <= 2100, `Expected truncation near 2000, got length: ${result.length}`);
        assert.ok(result.includes("[truncated]"), `Expected truncation indicator, got: ${result}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 10. Unsupported content type → error message
    async function test_unsupported_content_type(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/octet-stream" }),
          text: async () => "binary data",
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://example.com/file.bin" },
        );
        assert.equal(typeof result, "string");
        assert.ok(result.toLowerCase().includes("unsupported"), `Expected 'unsupported' in error, got: ${result}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    // 11. Readability fails → falls back to body textContent
    async function test_readability_fallback_to_text_content(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        // Minimal HTML that readability can't extract an article from
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `<html><body><p>Short fallback content</p></body></html>`,
        })));
        const result = await action_fn(
          { log: async () => "" },
          { url: "https://example.com/minimal" },
        );
        assert.equal(typeof result, "string");
        assert.ok(result.includes("Short fallback content"), `Expected fallback text, got: ${result}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  ],
  /**
   * @param {ActionContext} context
   * @param {{ url: string, max_length?: number }} params
   */
  action_fn: async function (context, params) {
    const maxLength = Math.max(1000, Math.min(50000, params.max_length ?? 16000));

    // Validate URL
    /** @type {URL} */
    let parsed;
    try {
      parsed = new URL(params.url);
    } catch {
      return `Error: Invalid URL "${params.url}"`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error: Only http and https URLs are supported, got "${parsed.protocol}"`;
    }

    await context.log(`Fetching ${params.url}`);

    // Fetch with timeout and body size limit
    /** @type {Response} */
    let response;
    try {
      response = await fetch(params.url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WhatsAppBot/1.0)",
          "Accept": "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return `Error: Request to ${params.url} timed out after 15 seconds`;
      }
      const message = err instanceof Error ? err.message : String(err);
      return `Error: Failed to fetch ${params.url} — ${message}`;
    }

    if (!response.ok) {
      return `Error: HTTP ${response.status} fetching ${params.url}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    if (!body.trim()) {
      return "Error: Response body is empty";
    }

    /** @type {string} */
    let content;

    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      content = extractHtml(body, params.url);
    } else if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        content = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        content = body;
      }
    } else if (contentType.includes("text/")) {
      content = body;
    } else {
      return `Error: Unsupported content type "${contentType}"`;
    }

    // Truncate if needed
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + "\n\n[truncated]";
    }

    return content;
  },
});

/**
 * Extract readable content from HTML, falling back to body textContent.
 * @param {string} html
 * @param {string} url
 * @returns {string}
 */
function extractHtml(html, url) {
  const { document } = parseHTML(html);
  const turndown = new TurndownService({ headingStyle: "atx" });

  const reader = new Readability(document, { charThreshold: 0 });
  const article = reader.parse();

  if (article && article.content.trim()) {
    const markdown = turndown.turndown(article.content).trim();
    if (markdown) {
      return article.title ? `# ${article.title}\n\n${markdown}` : markdown;
    }
  }

  // Fallback: get body textContent
  const { document: freshDoc } = parseHTML(html);
  const body = freshDoc.body;
  const text = body ? body.textContent?.trim() ?? "" : "";
  if (!text) return "Error: Could not extract content from page";

  const title = freshDoc.title?.trim();
  return title ? `# ${title}\n\n${text}` : text;
}
