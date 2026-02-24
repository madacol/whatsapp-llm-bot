import fs from "fs/promises";
import path from "path";

import assert from "node:assert/strict";
import config from "../config.js";
import {
  ensureChatActionsSchema,
  saveChatAction,
  readChatAction,
  deleteChatAction,
} from "../actions.js";

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
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  test_functions: [
    async function global_scope_rejects_non_master(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const context = {
          senderIds: ["non-master-user"],
          confirm: async () => true,
        };
        await assert.rejects(
          () => action_fn(context, { file_name: "testGlobalPerm", code: "// code", scope: "global" }),
          { message: /requires master/ },
        );
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function chat_scope_stores_in_db(action_fn, db) {
      await ensureChatActionsSchema(db);
      const context = {
        db,
        getIsAdmin: async () => true,
        confirm: async () => true,
      };
      const result = await action_fn(context, {
        file_name: "testChatAction",
        code: '// chat action code',
        proposed_tests: "- test: basic test",
        scope: "chat",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("testChatAction"), `Expected name in result, got: ${result}`);
      // Verify stored in DB, not filesystem
      const code = await readChatAction(db, "testChatAction");
      assert.equal(code, "// chat action code");
      const filePath = path.join(process.cwd(), "actions", "testChatAction.js");
      await assert.rejects(() => fs.access(filePath), "File should NOT exist on filesystem");
      // Cleanup
      await deleteChatAction(db, "testChatAction");
    },
    async function chat_scope_reads_from_db(action_fn, db) {
      await ensureChatActionsSchema(db);
      await saveChatAction(db, "testChatRead", "// chat read content");
      const context = {
        db,
        getIsAdmin: async () => true,
      };
      const result = await action_fn(context, {
        file_name: "testChatRead",
        mode: "read",
        scope: "chat",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.includes("// chat read content"), `Expected code content, got: ${result}`);
      // Cleanup
      await deleteChatAction(db, "testChatRead");
    },
    async function chat_scope_deletes_from_db(action_fn, db) {
      await ensureChatActionsSchema(db);
      await saveChatAction(db, "testChatDelete", "// to delete");
      const context = {
        db,
        getIsAdmin: async () => true,
        confirm: async () => true,
      };
      const result = await action_fn(context, {
        file_name: "testChatDelete",
        mode: "delete",
        scope: "chat",
      });
      assert.ok(typeof result === "string");
      assert.ok(result.toLowerCase().includes("deleted"), `Expected deleted message, got: ${result}`);
      const code = await readChatAction(db, "testChatDelete");
      assert.equal(code, null);
    },
    async function chat_scope_rejects_non_admin_in_group(action_fn, db) {
      await ensureChatActionsSchema(db);
      const context = {
        db,
        chatId: "group-chat",
        getIsAdmin: async () => false,
        confirm: async () => true,
      };
      await assert.rejects(
        () => action_fn(context, { file_name: "testChatNonAdmin", code: "// code", scope: "chat" }),
        { message: /admin/ },
      );
    },
    async function rejects_invalid_file_name(action_fn, _db) {
      await assert.rejects(
        () => action_fn({}, { file_name: "../evil", code: "// code" }),
        { message: /alphanumeric camelCase/ },
      );
    },
    async function rejects_on_user_denial(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        let confirmCalled = false;
        const context = {
          senderIds: ["master-user"],
          confirm: async () => { confirmCalled = true; return false; },
        };
        const result = await action_fn(context, {
          file_name: "testDenied",
          code: "// denied code",
          proposed_tests: "- checks_something: verifies basic behavior",
        });
        assert.ok(confirmCalled, "confirm should have been called");
        assert.ok(typeof result === "string");
        assert.ok(result.toLowerCase().includes("revise"), `Expected revision message, got: ${result}`);
        // Verify file was NOT written
        const filePath = path.join(process.cwd(), "actions", "testDenied.js");
        await assert.rejects(() => fs.access(filePath), "File should not exist");
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function shows_proposed_tests_in_confirm(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        /** @type {string} */
        let capturedMessage = "";
        const context = {
          senderIds: ["master-user"],
          confirm: async (/** @type {string} */ msg) => { capturedMessage = msg; return true; },
        };
        const filePath = path.join(process.cwd(), "actions", "testConfirmMsg.js");
        try {
          await action_fn(context, {
            file_name: "testConfirmMsg",
            code: "// confirm msg code",
            proposed_tests: "- validates_input: checks required fields\n- handles_error: returns error on failure",
          });
          assert.ok(capturedMessage.includes("validates_input"), `Confirm message should contain proposed test name, got: ${capturedMessage}`);
          assert.ok(capturedMessage.includes("handles_error"), `Confirm message should contain second test name, got: ${capturedMessage}`);
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function reads_existing_action(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const filePath = path.join(process.cwd(), "actions", "testReadTarget.js");
        try {
          await fs.writeFile(filePath, "// read target content", "utf-8");
          const context = { senderIds: ["master-user"], confirm: async () => true };
          const result = await action_fn(context, {
            file_name: "testReadTarget",
            mode: "read",
          });
          assert.ok(typeof result === "string");
          assert.ok(result.includes("// read target content"), `Expected file contents, got: ${result}`);
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function edit_rejects_nonexistent(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const result = await action_fn({ senderIds: ["master-user"] }, {
          file_name: "testNonexistentEdit",
          mode: "edit",
          code: "// edit code",
          proposed_tests: "- test: checks something",
        });
        assert.ok(typeof result === "string");
        assert.ok(result.toLowerCase().includes("create"), `Expected suggestion to use create, got: ${result}`);
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function create_rejects_existing(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const filePath = path.join(process.cwd(), "actions", "testExistingCreate.js");
        try {
          await fs.writeFile(filePath, "// existing", "utf-8");
          const result = await action_fn({ senderIds: ["master-user"] }, {
            file_name: "testExistingCreate",
            mode: "create",
            code: "// new code",
            proposed_tests: "- test: checks something",
          });
          assert.ok(typeof result === "string");
          assert.ok(result.toLowerCase().includes("edit"), `Expected suggestion to use edit, got: ${result}`);
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
    async function writes_file_on_confirmation(action_fn, _db) {
      const saved = config.MASTER_IDs;
      try {
        config.MASTER_IDs = ["master-user"];
        const context = {
          senderIds: ["master-user"],
          confirm: async () => true,
        };
        const filePath = path.join(process.cwd(), "actions", "testConfirmWrite.js");
        try {
          const result = await action_fn(context, {
            file_name: "testConfirmWrite",
            code: "// confirmed write",
            proposed_tests: "- basic_test: verifies something",
          });
          assert.ok(result.includes("testConfirmWrite"), `Should confirm creation, got: ${result}`);
          const content = await fs.readFile(filePath, "utf-8");
          assert.equal(content, "// confirmed write");
        } finally {
          await fs.rm(filePath, { force: true });
        }
      } finally {
        config.MASTER_IDs = saved;
      }
    },
  ],
  /** @param {ActionContext} context  @param {{ file_name: string, mode?: "create" | "read" | "edit" | "delete", code?: string, proposed_tests?: string, scope?: "global" | "chat" }} params */
  action_fn: async function (context, { file_name, mode = "create", code, proposed_tests, scope = "global" }) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(file_name)) {
      throw new Error(
        "file_name must be alphanumeric camelCase (no dots, slashes, or spaces)",
      );
    }

    // ── Chat-scoped actions ──
    if (scope === "chat") {
      const isAdmin = await context.getIsAdmin();
      if (!isAdmin) {
        throw new Error("Chat-scoped actions require admin permissions in group chats");
      }

      await ensureChatActionsSchema(context.db);

      if (mode === "read") {
        const stored = await readChatAction(context.db, file_name);
        if (!stored) return `Chat action not found: ${file_name}`;
        return stored;
      }

      if (mode === "delete") {
        const stored = await readChatAction(context.db, file_name);
        if (!stored) return `Chat action not found: ${file_name}`;
        const confirmed = await context.confirm(
          `*Delete chat action:* ${file_name}\n\nReact 👍 to confirm or 👎 to cancel.`,
        );
        if (!confirmed) {
          return "Deletion cancelled.";
        }
        await deleteChatAction(context.db, file_name);
        return `Chat action deleted: ${file_name}`;
      }

      if (!code) {
        throw new Error("code is required for create/edit modes");
      }

      const existing = await readChatAction(context.db, file_name);
      if (mode === "edit" && !existing) {
        return `Chat action not found: ${file_name} — use mode "create" to create a new action.`;
      }
      if (mode === "create" && existing) {
        return `Chat action already exists: ${file_name} — use mode "edit" to modify it.`;
      }

      const verb = mode === "edit" ? "Edit" : "Create";
      let preview = `*${verb} chat action:* ${file_name}`;
      if (proposed_tests) {
        preview += `\n\n*Proposed tests:*\n${proposed_tests}`;
      }
      preview += "\n\nReact 👍 to approve or 👎 to reject.";

      const confirmed = await context.confirm(preview);
      if (!confirmed) {
        return "Action rejected. Please revise the action and proposed tests based on user feedback, then retry.";
      }

      await saveChatAction(context.db, file_name, code);

      const pastVerb = mode === "edit" ? "updated" : "created";
      return `Chat action ${pastVerb}: ${file_name}`;
    }

    // ── Global-scoped actions (requires master) ──
    const isMaster = context.senderIds?.some(
      (/** @type {string} */ id) => config.MASTER_IDs.includes(id),
    );
    if (!isMaster) {
      throw new Error("Global-scoped actions requires master permissions");
    }

    const actionsDir = path.resolve(process.cwd(), "actions");
    const filePath = path.join(actionsDir, `${file_name}.js`);

    if (mode === "read") {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        return content;
      } catch {
        return `Action file not found: actions/${file_name}.js`;
      }
    }

    if (mode === "delete") {
      try {
        await fs.access(filePath);
      } catch {
        return `Action file not found: actions/${file_name}.js`;
      }
      const confirmed = await context.confirm(
        `*Delete action:* ${file_name}\n\nReact 👍 to confirm or 👎 to cancel.`,
      );
      if (!confirmed) {
        return "Deletion cancelled.";
      }
      await fs.rm(filePath);
      return `Action file deleted: actions/${file_name}.js`;
    }

    if (!code) {
      throw new Error("code is required for create/edit modes");
    }

    /** @type {boolean} */
    let fileExists;
    try {
      await fs.access(filePath);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    if (mode === "edit" && !fileExists) {
      return `Action file not found: actions/${file_name}.js — use mode "create" to create a new action.`;
    }

    if (mode === "create" && fileExists) {
      return `Action file already exists: actions/${file_name}.js — use mode "edit" to modify an existing action.`;
    }

    const verb = mode === "edit" ? "Edit" : "Create";
    let preview = `*${verb} action:* ${file_name}`;
    if (proposed_tests) {
      preview += `\n\n*Proposed tests:*\n${proposed_tests}`;
    }
    preview += "\n\nReact 👍 to approve or 👎 to reject.";

    const confirmed = await context.confirm(preview);
    if (!confirmed) {
      return "Action rejected. Please revise the action and proposed tests based on user feedback, then retry.";
    }

    await fs.writeFile(filePath, code, "utf-8");

    const pastVerb = mode === "edit" ? "updated" : "created";
    return `Action file ${pastVerb}: actions/${file_name}.js`;
  },
});
