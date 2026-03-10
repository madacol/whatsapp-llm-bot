import fs from "node:fs/promises";
import path from "node:path";

import config from "../../../config.js";
import {
  ensureChatActionsSchema,
  saveChatAction,
  readChatAction,
  deleteChatAction,
  getChatActions,
} from "../../../actions.js";


/**
 * @typedef {{
 *   read: (name: string) => Promise<string | null>,
 *   write: (name: string, code: string) => Promise<void>,
 *   remove: (name: string) => Promise<void>,
 *   label: (name: string) => string,
 * }} ActionStorage
 */

/**
 * Shared CRUD logic for both chat-scoped and global-scoped actions.
 * @param {ActionStorage} storage
 * @param {{ mode: string, fileName: string, code?: string, proposedTests?: string, confirm: (msg: string) => Promise<boolean> }} opts
 * @returns {Promise<string>}
 */
async function executeActionCrud(storage, { mode, fileName, code, proposedTests, confirm }) {
  const label = storage.label(fileName);

  if (mode === "read") {
    const content = await storage.read(fileName);
    if (!content) return `${label} not found`;
    return content;
  }

  if (mode === "delete") {
    const content = await storage.read(fileName);
    if (!content) return `${label} not found`;
    const confirmed = await confirm(
      `*Delete:* ${label}\n\nReact 👍 to confirm or 👎 to cancel.`,
    );
    if (!confirmed) return "Deletion cancelled.";
    await storage.remove(fileName);
    return `${label} deleted`;
  }

  if (!code) {
    return "code is required for create/edit modes";
  }

  const existing = await storage.read(fileName);
  if (mode === "edit" && !existing) {
    return `${label} not found — use mode "create" to create a new action.`;
  }
  if (mode === "create" && existing) {
    return `${label} already exists — use mode "edit" to modify it.`;
  }

  const verb = mode === "edit" ? "Edit" : "Create";
  let preview = `*${verb}:* ${label}`;
  if (proposedTests) {
    preview += `\n\n*Proposed tests:*\n${proposedTests}`;
  }
  preview += "\n\nReact 👍 to approve or 👎 to reject.";

  const confirmed = await confirm(preview);
  if (!confirmed) {
    return "Action rejected. Please revise the action and proposed tests based on user feedback, then retry.";
  }

  await storage.write(fileName, code);

  const pastVerb = mode === "edit" ? "updated" : "created";
  return `${label} ${pastVerb}`;
}

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
    //   log, send, reply, reactToMessage, sendPoll, confirm
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
    globalThis.fetch = /** @type {typeof fetch} */ (async () => ({
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
    globalThis.fetch = /** @type {typeof fetch} */ (async () => ({ ok: false, status: 500 }));
    const result = await action_fn({ log: async () => "" }, { query: "test" });
    assert.ok(result.includes("500"));
  } finally { globalThis.fetch = originalFetch; }
}
\`\`\`

## Reading and editing actions

- Use \`mode: "read"\` to inspect an action's source before editing.
- Use \`mode: "edit"\` to overwrite an existing action (requires confirmation).
- Use \`mode: "create"\` (default) only for new actions.

## Confirmation flow

Before the file is written, the user must approve the action. Always provide \`proposed_tests\` — a concise summary with one line per test function (name + what it asserts). The user will review the action name and proposed tests before approving. If rejected, revise the action based on user feedback and retry.

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
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          json: async () => ({ web: { results: [
            { title: "Result 1", url: "https://example.com", description: "Desc 1" },
          ]}}),
        })));
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
      mode: {
        type: "string",
        enum: ["create", "read", "edit", "delete"],
        description:
          'Operation mode: "create" (default) for new actions, "read" to inspect source, "edit" to overwrite existing, "delete" to remove an action',
      },
      code: {
        type: "string",
        description: "Complete file content (ES module with default export). Required for create/edit modes.",
      },
      proposed_tests: {
        type: "string",
        description:
          "Human-readable summary of test functions (one line per test: name + what it asserts)",
      },
      scope: {
        type: "string",
        enum: ["global", "chat"],
        description:
          'Scope: "global" (default) writes to filesystem (requires master), "chat" stores in this chat\'s DB (requires admin in groups, anyone in personal chats)',
      },
    },
    required: ["file_name"],
  },
  formatToolCall: ({ file_name, mode }) => {
    const op = mode === "delete" ? "Deleting" : mode === "read" ? "Reading" : mode === "edit" ? "Editing" : "Creating";
    return `${op} action: ${file_name ?? "unknown"}`;
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /** @param {ActionContext} context  @param {{ file_name: string, mode?: "create" | "read" | "edit" | "delete", code?: string, proposed_tests?: string, scope?: "global" | "chat" }} params */
  action_fn: async function (context, { file_name, mode = "create", code, proposed_tests, scope = "global" }) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(file_name)) {
      return "file_name must be alphanumeric camelCase (no dots, slashes, or spaces)";
    }

    /** @type {ActionStorage} */
    let storage;

    if (scope === "chat") {
      const isAdmin = await context.getIsAdmin();
      if (!isAdmin) {
        throw new Error("Chat-scoped actions require admin permissions in group chats");
      }
      await ensureChatActionsSchema(context.db);
      const db = context.db;
      storage = {
        read: (name) => readChatAction(db, name),
        write: (name, c) => saveChatAction(db, name, c),
        remove: (name) => deleteChatAction(db, name),
        label: (name) => `Chat action: ${name}`,
      };
    } else {
      const isMaster = context.senderIds?.some(
        (/** @type {string} */ id) => config.MASTER_IDs.includes(id),
      );
      if (!isMaster) {
        throw new Error("Global-scoped actions requires master permissions");
      }
      const actionsDir = path.resolve(process.cwd(), "actions");
      storage = {
        read: async (name) => {
          try { return await fs.readFile(path.join(actionsDir, `${name}.js`), "utf-8"); }
          catch { return null; }
        },
        write: (name, c) => fs.writeFile(path.join(actionsDir, `${name}.js`), c, "utf-8"),
        remove: (name) => fs.rm(path.join(actionsDir, `${name}.js`)),
        label: (name) => `Action file: actions/${name}.js`,
      };
    }

    // Guard against duplicate action names across both global and chat-scoped actions.
    if (code && (mode === "create" || mode === "edit")) {
      const nameFromCode = code.match(/name:\s*["']([^"']+)["']/)?.[1];
      if (nameFromCode) {
        const [globalActions, chatActions] = await Promise.all([
          context.getActions(),
          getChatActions(context.chatId),
        ]);
        const conflict = [...globalActions, ...chatActions].find(a => a.name === nameFromCode);
        if (conflict) {
          // Allow editing the action that already owns this name
          const ownContent = await storage.read(file_name);
          const ownName = ownContent?.match(/name:\s*["']([^"']+)["']/)?.[1];
          if (ownName !== nameFromCode) {
            return `An action named "${nameFromCode}" already exists. Use mode "edit" on the existing action instead of creating a duplicate.`;
          }
        }
      }
    }

    return executeActionCrud(storage, {
      mode,
      fileName: file_name,
      code,
      proposedTests: proposed_tests,
      confirm: (msg) => context.confirm(msg),
    });
  },
});
