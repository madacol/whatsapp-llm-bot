import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import config from "../config.js";
import { createTestDb } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {typeof import("../actions.js").executeAction} */
let executeAction;

/** @type {typeof import("../pending-confirmations.js")} */
let pendingMod;

/** @type {PGlite} */
let testDb;

before(async () => {
  // Seed DB cache so getDb() calls during executeAction return in-memory DBs
  // instead of creating on-disk PGlite instances that consume lots of RAM
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  setDb("memory://", testDb);

  // Pre-seed per-action DB paths that executeAction will request
  const actionNames = [
    "test_action", "confirm_action", "result_action",
    "db_action", "llm_action",
  ];
  for (const name of actionNames) {
    setDb(`./pgdata/test-chat/${name}`, testDb);
  }

  const mod = await import("../actions.js");
  executeAction = mod.executeAction;

  pendingMod = await import("../pending-confirmations.js");
  await pendingMod.initPendingConfirmationsTable(testDb);
});




/**
 * Create a mock action resolver
 * @param {Record<string, Action>} actionMap
 * @returns {(name: string) => Promise<AppAction|null>}
 */
function createResolver(actionMap) {
  return async (name) => {
    const action = actionMap[name];
    if (!action) return null;
    return /** @type {AppAction} */ ({ ...action, fileName: "mock.js", app_name: "" });
  };
}

/**
 * Create a minimal Context for testing
 * @param {Partial<Context>} [overrides]
 * @returns {Context}
 */
function createMockContext(overrides = {}) {
  return {
    chatId: "test-chat",
    senderIds: ["master-user"],
    content: [],
    isDebug: false,
    getIsAdmin: async () => true,
    sendMessage: async () => {},
    reply: async () => {},
    reactToMessage: async () => {},
    sendPoll: async () => {},
    confirm: async () => true,
    ...overrides,
  };
}

describe("config", () => {
  it("MASTER_IDs is always an array", async () => {
    assert.ok(Array.isArray(config.MASTER_IDs), `Expected array, got ${typeof config.MASTER_IDs}: ${JSON.stringify(config.MASTER_IDs)}`);
  });
});

describe("executeAction", () => {
  it("throws for non-existent action", async () => {
    const resolver = createResolver({});
    await assert.rejects(
      () => executeAction("nonexistent", createMockContext(), {}, { actionResolver: resolver }),
      { message: /not found/ },
    );
  });

  it("throws when requireMaster and sender is not master", async () => {
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, requireMaster: true },
        action_fn: async () => "ok",
      },
    });
    const ctx = createMockContext({ senderIds: ["non-master"] });
    await assert.rejects(
      () => executeAction("test_action", ctx, {}, { actionResolver: resolver }),
      { message: /master/ },
    );
  });

  it("passes when requireMaster and sender is master", async () => {
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, requireMaster: true },
        action_fn: async () => "success",
      },
    });
    const ctx = createMockContext({ senderIds: ["master-user"] });
    const { result } = await executeAction("test_action", ctx, {}, { actionResolver: resolver });
    assert.equal(result, "success");
  });

  it("cancels action when confirm returns false", async () => {
    const resolver = createResolver({
      confirm_action: {
        name: "confirm_action",
        description: "needs confirmation",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: false },
        action_fn: async () => "ok",
      },
    });
    const ctx = createMockContext({ confirm: async () => false });
    const { result } = await executeAction("confirm_action", ctx, {}, { actionResolver: resolver });
    assert.match(result, /cancelled/);
  });

  it("executes action when confirm returns true", async () => {
    const resolver = createResolver({
      confirm_action: {
        name: "confirm_action",
        description: "needs confirmation",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: false },
        action_fn: async () => "confirmed result",
      },
    });
    const ctx = createMockContext({ confirm: async () => true });
    const { result } = await executeAction("confirm_action", ctx, {}, { actionResolver: resolver });
    assert.equal(result, "confirmed result");
  });

  it("passes result through correctly", async () => {
    const resolver = createResolver({
      result_action: {
        name: "result_action",
        description: "returns object",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true },
        action_fn: async () => ({ key: "value" }),
      },
    });
    const { result, permissions } = await executeAction(
      "result_action", createMockContext(), {}, { actionResolver: resolver },
    );
    assert.deepEqual(result, { key: "value" });
    assert.equal(permissions.autoExecute, true);
  });

  it("provides useRootDb when permission is set", async () => {
    let receivedContext;
    const resolver = createResolver({
      db_action: {
        name: "db_action",
        description: "uses root db",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, useRootDb: true },
        action_fn: async (ctx) => {
          receivedContext = ctx;
          return "ok";
        },
      },
    });
    await executeAction("db_action", createMockContext(), {}, { actionResolver: resolver });
    assert.ok(receivedContext.rootDb, "rootDb should be set");
  });

  it("rejects when requireAdmin and sender is not admin", async () => {
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, requireAdmin: true },
        action_fn: async () => "ok",
      },
    });
    const ctx = createMockContext({ getIsAdmin: async () => false });
    await assert.rejects(
      () => executeAction("test_action", ctx, {}, { actionResolver: resolver }),
      { message: /admin/ },
    );
  });

  it("passes when requireAdmin and sender is admin", async () => {
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, requireAdmin: true },
        action_fn: async () => "admin success",
      },
    });
    const ctx = createMockContext({ getIsAdmin: async () => true });
    const { result } = await executeAction("test_action", ctx, {}, { actionResolver: resolver });
    assert.equal(result, "admin success");
  });

  it("log() returns joined message without sending to chat", async () => {
    /** @type {string[]} */
    const sent = [];
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true },
        action_fn: async (ctx) => {
          const logged = await ctx.log("hello", "world");
          assert.equal(logged, "hello world");
          return "ok";
        },
      },
    });
    const ctx = createMockContext({
      sendMessage: async (_header, _text) => { sent.push(`${_header} ${_text ?? ""}`); },
    });
    await executeAction("test_action", ctx, {}, { toolCallId: "call-123", actionResolver: resolver });
    assert.ok(
      !sent.some((s) => s.includes("hello")),
      `log() should not send messages to chat, got: ${JSON.stringify(sent)}`,
    );
  });

  it("provides callLlm when useLlm permission is set and llmClient is provided", async () => {
    const { createLlmClient } = await import("../llm.js");
    const injectedClient = createLlmClient();
    let receivedContext;
    const resolver = createResolver({
      llm_action: {
        name: "llm_action",
        description: "uses llm",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, useLlm: true },
        action_fn: async (ctx) => {
          receivedContext = ctx;
          return "ok";
        },
      },
    });
    await executeAction("llm_action", createMockContext(), {}, { actionResolver: resolver, llmClient: injectedClient });
    assert.equal(typeof receivedContext.callLlm, "function");
  });

  it("throws when useLlm is set but no llmClient is provided", async () => {
    const resolver = createResolver({
      llm_action: {
        name: "llm_action",
        description: "uses llm",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, useLlm: true },
        action_fn: async () => "ok",
      },
    });
    await assert.rejects(
      () => executeAction("llm_action", createMockContext(), {}, { actionResolver: resolver }),
      { message: /no llmClient was provided/ },
    );
  });

  it("overrides autoContinue when action_fn returns { result, autoContinue }", async () => {
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, autoContinue: true },
        action_fn: async () => ({ result: "cancelled", autoContinue: false }),
      },
    });
    const { result, permissions } = await executeAction(
      "test_action", createMockContext(), {}, { actionResolver: resolver },
    );
    assert.equal(result, "cancelled");
    assert.equal(permissions.autoContinue, false);
  });

  it("does not override autoContinue for plain string results", async () => {
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, autoContinue: true },
        action_fn: async () => "plain string",
      },
    });
    const { result, permissions } = await executeAction(
      "test_action", createMockContext(), {}, { actionResolver: resolver },
    );
    assert.equal(result, "plain string");
    assert.equal(permissions.autoContinue, true);
  });

  it("saves pending confirmation to DB when confirm is called (non-autoExecute)", async () => {
    // Clean up any leftover rows
    await testDb.query("DELETE FROM pending_confirmations");

    /** @type {{ onSent?: Function, onResolved?: Function }} */
    let capturedHooks = {};
    const resolver = createResolver({
      confirm_action: {
        name: "confirm_action",
        description: "needs confirmation",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: false },
        action_fn: async () => "confirmed",
      },
    });

    // Provide a confirm that captures the hooks and simulates the flow
    const ctx = createMockContext({
      confirm: async (message, hooks) => {
        capturedHooks = hooks || {};
        // Simulate: onSent is called after message is sent
        if (hooks?.onSent) {
          await hooks.onSent({ id: "test-msg-key", remoteJid: "test-chat" });
        }
        // Check: row should now exist in DB
        const rows = await pendingMod.loadPendingConfirmations(testDb);
        assert.ok(rows.some(r => r.msg_key_id === "test-msg-key"), "Pending confirmation should be saved after onSent");

        // Simulate: user reacts 👍
        if (hooks?.onResolved) {
          await hooks.onResolved({ id: "test-msg-key", remoteJid: "test-chat" }, true);
        }
        return true;
      },
    });

    const { result } = await executeAction("confirm_action", ctx, { a: 1 }, { toolCallId: "tc-1", actionResolver: resolver });
    assert.equal(result, "confirmed");

    // After resolution, row should be deleted
    const rowsAfter = await pendingMod.loadPendingConfirmations(testDb);
    assert.ok(!rowsAfter.some(r => r.msg_key_id === "test-msg-key"), "Pending confirmation should be deleted after onResolved");
  });

  it("deletes pending confirmation from DB when confirm resolves false", async () => {
    await testDb.query("DELETE FROM pending_confirmations");

    const resolver = createResolver({
      confirm_action: {
        name: "confirm_action",
        description: "needs confirmation",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: false },
        action_fn: async () => "confirmed",
      },
    });

    const ctx = createMockContext({
      confirm: async (message, hooks) => {
        if (hooks?.onSent) {
          await hooks.onSent({ id: "reject-msg-key", remoteJid: "test-chat" });
        }
        if (hooks?.onResolved) {
          await hooks.onResolved({ id: "reject-msg-key", remoteJid: "test-chat" }, false);
        }
        return false;
      },
    });

    const { result } = await executeAction("confirm_action", ctx, {}, { actionResolver: resolver });
    assert.match(result, /cancelled/);

    const rowsAfter = await pendingMod.loadPendingConfirmations(testDb);
    assert.ok(!rowsAfter.some(r => r.msg_key_id === "reject-msg-key"), "Should be cleaned up even on rejection");
  });
});
