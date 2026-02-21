import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Env vars must be set before dynamic import of actions.js (which loads config.js)
process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb } from "./helpers.js";
import { setDb, closeAllDbs } from "../db.js";

/** @type {typeof import("../actions.js").executeAction} */
let executeAction;

before(async () => {
  // Seed DB cache so getDb() calls during executeAction return in-memory DBs
  // instead of creating on-disk PGlite instances that consume lots of RAM
  const testDb = await createTestDb();
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
});

after(async () => {
  await closeAllDbs();
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
    const config = (await import("../config.js")).default;
    assert.ok(Array.isArray(config.MASTER_IDs), `Expected array, got ${typeof config.MASTER_IDs}: ${JSON.stringify(config.MASTER_IDs)}`);
  });
});

describe("executeAction", () => {
  it("throws for non-existent action", async () => {
    const resolver = createResolver({});
    await assert.rejects(
      () => executeAction("nonexistent", createMockContext(), {}, null, resolver),
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
      () => executeAction("test_action", ctx, {}, null, resolver),
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
    const { result } = await executeAction("test_action", ctx, {}, null, resolver);
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
    const { result } = await executeAction("confirm_action", ctx, {}, null, resolver);
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
    const { result } = await executeAction("confirm_action", ctx, {}, null, resolver);
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
      "result_action", createMockContext(), {}, null, resolver,
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
    await executeAction("db_action", createMockContext(), {}, null, resolver);
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
      () => executeAction("test_action", ctx, {}, null, resolver),
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
    const { result } = await executeAction("test_action", ctx, {}, null, resolver);
    assert.equal(result, "admin success");
  });

  it("log() does NOT sendMessage when isDebug is false", async () => {
    /** @type {string[]} */
    const sent = [];
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true },
        action_fn: async (ctx) => {
          await ctx.log("debug info");
          return "ok";
        },
      },
    });
    const ctx = createMockContext({
      isDebug: false,
      sendMessage: async (_header, _text) => { sent.push(`${_header} ${_text ?? ""}`); },
    });
    await executeAction("test_action", ctx, {}, "call-123", resolver);
    assert.ok(
      !sent.some((s) => s.includes("Log")),
      `log() should NOT send messages when isDebug is false, got: ${JSON.stringify(sent)}`,
    );
  });

  it("log() DOES sendMessage when isDebug is true", async () => {
    /** @type {string[]} */
    const sent = [];
    const resolver = createResolver({
      test_action: {
        name: "test_action",
        description: "test",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true },
        action_fn: async (ctx) => {
          await ctx.log("debug info");
          return "ok";
        },
      },
    });
    const ctx = createMockContext({
      isDebug: true,
      sendMessage: async (_header, _text) => { sent.push(`${_header} ${_text ?? ""}`); },
    });
    await executeAction("test_action", ctx, {}, "call-123", resolver);
    assert.ok(
      sent.some((s) => s.includes("debug info")),
      `log() should send messages when isDebug is true, got: ${JSON.stringify(sent)}`,
    );
  });

  it("provides callLlm when useLlm permission is set", async () => {
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
    await executeAction("llm_action", createMockContext(), {}, null, resolver);
    assert.equal(typeof receivedContext.callLlm, "function");
  });

  it("overrides autoContinue when action_fn returns ActionSignal", async () => {
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
      "test_action", createMockContext(), {}, null, resolver,
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
      "test_action", createMockContext(), {}, null, resolver,
    );
    assert.equal(result, "plain string");
    assert.equal(permissions.autoContinue, true);
  });
});
