import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  ensureChatActionsSchema,
  saveChatAction,
  readChatAction,
  getChatActions,
  getChatAction,
  ALLOWED_CHAT_PERMISSIONS,
} from "../actions.js";
import { setDb } from "../db.js";

/** @type {PGlite} */
let db;

before(async () => {
  db = new PGlite("memory://");
  // Point the DB cache at our test db for the chat action paths
  setDb("./pgdata/test-chat-id/create_action", db);
  await ensureChatActionsSchema(db);
});

describe("saveChatAction / readChatAction", () => {
  it("upserts on duplicate name", async () => {
    await saveChatAction(db, "upsert_test", "// v1");
    await saveChatAction(db, "upsert_test", "// v2");
    const code = await readChatAction(db, "upsert_test");
    assert.equal(code, "// v2");
  });

});

describe("getChatActions", () => {
  it("returns loaded actions from DB", async () => {
    const code = `
import assert from "node:assert/strict";
export default /** @type {defineAction} */ ((x) => x)({
  name: "chat_hello",
  description: "Says hello",
  parameters: { type: "object", properties: {} },
  permissions: { autoExecute: true },
  test_functions: [
    async function basic_test(action_fn) {
      const result = await action_fn({}, {});
      assert.equal(result, "hello from chat action");
    }
  ],
  action_fn: async function(context, params) {
    return "hello from chat action";
  }
});
`;
    await saveChatAction(db, "chat_hello", code);
    const actions = await getChatActions("test-chat-id");
    const found = actions.find(a => a.name === "chat_hello");
    assert.ok(found, "Should find chat_hello in loaded actions");
    assert.equal(found.scope, "chat");
    assert.equal(found.app_name, "");
    // Verify it actually works
    const result = await found.action_fn(/** @type {ExtendedActionContext<PermissionFlags>} */ ({}), {});
    assert.equal(result, "hello from chat action");
  });

  it("clamps permissions to allowed set", async () => {
    const code = `
export default {
  name: "chat_restricted",
  description: "Has restricted perms",
  parameters: { type: "object", properties: {} },
  permissions: { autoExecute: true, requireMaster: true, useRootDb: true, useChatDb: true, useLlm: true },
  test_functions: [async function noop() {}],
  action_fn: async function() { return "ok"; }
};
`;
    await saveChatAction(db, "chat_restricted", code);
    const actions = await getChatActions("test-chat-id");
    const found = actions.find(a => a.name === "chat_restricted");
    assert.ok(found);
    // Allowed: autoExecute, autoContinue, useLlm, requireAdmin
    assert.equal(found.permissions.autoExecute, true);
    assert.equal(found.permissions.useLlm, true);
    // Disallowed: requireMaster, useRootDb, useChatDb
    assert.equal(found.permissions.requireMaster, undefined);
    assert.equal(found.permissions.useRootDb, undefined);
    assert.equal(found.permissions.useChatDb, undefined);
  });

});

describe("getChatAction", () => {
  it("loads a single chat action by name", async () => {
    const code = `
export default {
  name: "single_action",
  description: "A single action",
  parameters: { type: "object", properties: {} },
  permissions: { autoExecute: true },
  test_functions: [async function noop() {}],
  action_fn: async function() { return "single"; }
};
`;
    await saveChatAction(db, "single_action", code);
    const action = await getChatAction("test-chat-id", "single_action");
    assert.ok(action);
    assert.equal(action.name, "single_action");
    assert.equal(action.scope, "chat");
  });

  it("returns null for nonexistent action", async () => {
    const action = await getChatAction("test-chat-id", "does_not_exist");
    assert.equal(action, null);
  });
});

describe("ALLOWED_CHAT_PERMISSIONS", () => {
  it("contains only the expected permissions", () => {
    assert.deepEqual(
      [...ALLOWED_CHAT_PERMISSIONS].sort(),
      ["autoContinue", "autoExecute", "requireAdmin", "useLlm"],
    );
  });
});
