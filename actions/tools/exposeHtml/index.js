import { storeAndLinkHtml } from "../../../html-store.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "expose_html",
  description:
    "Expose static, harmless HTML as a browser-viewable page and return a link. Use this for reports, dashboards, tables, diagrams, previews, or other rich visual artifacts.",
  instructions:
    "Pass complete static HTML for a page body or full document. Do not include scripts, inline event handlers, or javascript: URLs. CSS is fine. The HTML is stored as a file in the current chat folder and served as a static page.",
  parameters: {
    type: "object",
    properties: {
      html: {
        type: "string",
        description: "Static HTML to expose. Scripts, inline event handlers, and javascript: URLs are rejected.",
      },
      title: {
        type: "string",
        description: "Optional page title shown in the link and browser tab.",
      },
    },
    required: ["html"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  formatToolCall: ({ title }) => title ? `Exposing HTML page: ${title}` : "Exposing HTML page",
  /**
   * @param {ActionContext} context
   * @param {{ html?: string, title?: string }} params
   */
  action_fn: async function (context, params) {
    const html = params.html?.trim();
    if (!html) {
      return "Cannot expose an empty HTML page.";
    }
    return storeAndLinkHtml(context.chatId, {
      __brand: "html",
      html,
      ...(params.title?.trim() ? { title: params.title.trim() } : {}),
    });
  },
});
