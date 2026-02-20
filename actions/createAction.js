import fs from "fs/promises";
import path from "path";

import assert from "node:assert/strict";

const description = `Create a new action file in the actions/ directory. The code must be a complete ES module that default-exports an action object.

## Rules
- MUST include \`import assert from "node:assert/strict";\` at the top.
- MUST include a non-empty \`test_functions\` array — actions without tests will be rejected by the test suite.
- Use JSDoc type annotations on action_fn params. Never use \`@type {any}\` in production code.
- Only set the permissions you actually need.
- Return user-facing strings on success. Throw errors for infra/precondition failures. Return error strings for expected invalid input.
- For external API calls, use \`fetch\` directly (no libraries).

## Boilerplate

\`\`\`js
import assert from "node:assert/strict";

export default /** @type {defineAction} */ ((x) => x)({
  name: "action_name",        // snake_case
  command: "cmd",              // optional shortcut (!cmd)
  description: "What it does",
  parameters: {
    type: "object",
    properties: {
      paramName: { type: "string", description: "..." }
    },
    required: ["paramName"]
  },
  permissions: {
    autoExecute: true,    // execute without confirmation
    autoContinue: true,   // continue LLM processing after
    requireAdmin: true,   // requires group admin
    requireMaster: true,  // requires MASTER_ID
    useChatDb: true,      // adds chatDb (PGlite) to context
    useRootDb: true,      // adds rootDb (PGlite) to context
    useLlm: true,         // adds callLlm(prompt, options?) to context
  },
  test_functions: [
    // REQUIRED — at least one test function
    // Signature: async function descriptive_snake_case_name(action_fn, db)
    // Use _db if db is unused. Tests run against a real PGlite instance.
  ],
  /** @param {ActionContext} context  @param {{ paramName: string }} params */
  action_fn: async function (context, params) {
    // context has: chatId, senderIds, content, getIsAdmin, sessionDb, getActions,
    //   log, sendMessage, reply, reactToMessage, sendPoll, confirm
    // plus permission-granted extras: rootDb (useRootDb), chatDb (useChatDb), callLlm (useLlm)
    return "result string";
  }
});
\`\`\`

## Testing patterns

**DB actions** — insert test data with unique prefixed IDs, call action_fn, assert both the return string and the DB state:
\`\`\`js
async function sets_value(action_fn, db) {
  await db.sql\`INSERT INTO chats(chat_id) VALUES ('act-myact-1') ON CONFLICT DO NOTHING\`;
  const result = await action_fn({ chatId: "act-myact-1", rootDb: db }, { key: "val" });
  assert.ok(result.includes("val"));
  const { rows: [row] } = await db.sql\`SELECT col FROM chats WHERE chat_id = 'act-myact-1'\`;
  assert.equal(row.col, "val");
}
\`\`\`

**External API actions** — mock globalThis.fetch in try/finally, always restore:
\`\`\`js
async function returns_data(action_fn) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = /** @type {any} */ (async () => ({
      ok: true,
      json: async () => ({ results: [{ title: "Test" }] }),
    }));
    const result = await action_fn({ log: async () => "" }, { query: "test" });
    assert.ok(result.includes("Test"));
  } finally {
    globalThis.fetch = originalFetch;
  }
}
\`\`\`

**Config-dependent actions** — import config and save/restore fields in try/finally:
\`\`\`js
import config from "../config.js";
// in test:
const saved = config.some_key;
try { config.some_key = "test-val"; /* ... */ } finally { config.some_key = saved; }
\`\`\`

**Error cases** — always test at least one error path (missing input, API failure, etc.):
\`\`\`js
async function handles_api_error(action_fn) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = /** @type {any} */ (async () => ({ ok: false, status: 500 }));
    const result = await action_fn({ log: async () => "" }, { query: "test" });
    assert.ok(result.includes("500"));
  } finally { globalThis.fetch = originalFetch; }
}
\`\`\`

## Complete example (external API action with config)

\`\`\`js
import assert from "node:assert/strict";
import config from "../config.js";

export default /** @type {defineAction} */ ((x) => x)({
  name: "search_web",
  command: "search",
  description: "Search the web for current information. Returns titles, URLs, and descriptions.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: { type: "number", description: "Number of results (1-10, default 5)" },
    },
    required: ["query"],
  },
  permissions: { autoExecute: true, autoContinue: true },
  test_functions: [
    async function returns_formatted_results(action_fn) {
      const originalFetch = globalThis.fetch;
      const savedKey = config.brave_api_key;
      try {
        config.brave_api_key = "test-key";
        globalThis.fetch = /** @type {any} */ (async () => ({
          ok: true,
          json: async () => ({ web: { results: [
            { title: "Result 1", url: "https://example.com", description: "Desc 1" },
          ]}}),
        }));
        const result = await action_fn({ log: async () => "" }, { query: "test" });
        assert.ok(result.includes("Result 1"));
        assert.ok(result.includes("https://example.com"));
      } finally {
        globalThis.fetch = originalFetch;
        config.brave_api_key = savedKey;
      }
    },
    async function errors_without_api_key(action_fn) {
      const savedKey = config.brave_api_key;
      try {
        config.brave_api_key = undefined;
        const result = await action_fn({ log: async () => "" }, { query: "test" });
        assert.ok(result.toLowerCase().includes("brave_api_key"));
      } finally { config.brave_api_key = savedKey; }
    },
  ],
  /** @param {ActionContext} context  @param {{ query: string, count?: number }} params */
  action_fn: async function (context, params) {
    const apiKey = config.brave_api_key;
    if (!apiKey) return "Error: BRAVE_API_KEY is not configured.";
    const count = Math.max(1, Math.min(10, params.count ?? 5));
    await context.log("Searching: " + params.query);
    const url = "https://api.search.brave.com/res/v1/web/search"
      + "?q=" + encodeURIComponent(params.query) + "&count=" + count;
    const response = await fetch(url, {
      headers: { "X-Subscription-Token": apiKey },
    });
    if (!response.ok) return "Error: API returned status " + response.status;
    /** @type {{ web?: { results?: Array<{ title: string, url: string, description: string }> } }} */
    const data = await response.json();
    const results = data.web?.results ?? [];
    if (results.length === 0) return "No results found.";
    return results.map((r) => "**" + r.title + "**\\n" + r.url + "\\n" + r.description).join("\\n\\n");
  },
});
\`\`\``;

export default /** @type {defineAction} */ ((x) => x)({
  name: "create_action",
  description,
  parameters: {
    type: "object",
    properties: {
      file_name: {
        type: "string",
        description:
          "camelCase file name without extension (e.g. 'myAction' creates actions/myAction.js)",
      },
      code: {
        type: "string",
        description: "Complete file content (ES module with default export)",
      },
    },
    required: ["file_name", "code"],
  },
  permissions: {
    autoExecute: true,
    requireMaster: true,
  },
  test_functions: [
    async function rejects_invalid_file_name(action_fn, _db) {
      await assert.rejects(
        () => action_fn({}, { file_name: "../evil", code: "// code" }),
        { message: /alphanumeric camelCase/ },
      );
    },
  ],
  action_fn: async function (_context, { file_name, code }) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(file_name)) {
      throw new Error(
        "file_name must be alphanumeric camelCase (no dots, slashes, or spaces)",
      );
    }

    const actionsDir = path.resolve(process.cwd(), "actions");
    const filePath = path.join(actionsDir, `${file_name}.js`);

    await fs.writeFile(filePath, code, "utf-8");

    return `Action file created: actions/${file_name}.js`;
  },
});
