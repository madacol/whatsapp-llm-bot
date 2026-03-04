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
      content = extractHtml(body);
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
 * @returns {string}
 */
function extractHtml(html) {
  const { document } = parseHTML(html);
  const turndown = new TurndownService({ headingStyle: "atx" });

  const reader = new Readability(document, { charThreshold: 0 });
  const article = reader.parse();
  const content = article?.content;

  if (content?.trim()) {
    const markdown = turndown.turndown(content).trim();
    if (markdown) {
      return article?.title ? `# ${article.title}\n\n${markdown}` : markdown;
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
