process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, seedChat } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {typeof import("../index.js").createReactionHandler} */
let createReactionHandler;

const CHAT_ID = "reaction-test-chat";

/**
 * Build a mock pending confirmation row.
 * @param {Partial<import("../pending-confirmations.js").PendingConfirmationRow>} [overrides]
 * @returns {import("../pending-confirmations.js").PendingConfirmationRow}
 */
function makePending(overrides = {}) {
  return {
    id: 1,
    chat_id: CHAT_ID,
    msg_key_id: "msg-key-1",
    msg_key_remote_jid: "remote-jid-1",
    action_name: "testAction",
    action_params: { foo: "bar" },
    tool_call_id: "call_abc123",
    sender_ids: ["sender-1"],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a minimal ReactionEvent.
 * @param {string} msgKeyId
 * @param {string} emoji
 * @returns {import("../whatsapp-adapter.js").ReactionEvent}
 */
function makeReactionEvent(msgKeyId, emoji) {
  return {
    key: { id: msgKeyId, remoteJid: "remote-jid-1" },
    reaction: { text: emoji },
  };
}

/**
 * Build a mock sock with sendMessage spy.
 * @returns {{ sendMessage: Function, sent: Array<{jid: string, content: object}> }}
 */
function makeSock() {
  /** @type {Array<{jid: string, content: object}>} */
  const sent = [];
  return {
    sent,
    sendMessage: async (/** @type {string} */ jid, /** @type {object} */ content) => {
      sent.push({ jid, content });
    },
  };
}

describe("createReactionHandler", { concurrency: 1 }, () => {

before(async () => {
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  const { initStore } = await import("../store.js");
  store = await initStore(testDb);
  ({ createReactionHandler } = await import("../index.js"));
  await seedChat(testDb, CHAT_ID, { enabled: true });
});

it("stores tool result on approval", async () => {
  const pending = makePending();
  /** @type {Map<string, import("../pending-confirmations.js").PendingConfirmationRow>} */
  const pendingByMsgKeyId = new Map([[pending.msg_key_id, pending]]);

  /** @type {string[]} */
  const addMessageCalls = [];
  const mockStore = {
    addMessage: async (/** @type {string} */ chatId, /** @type {ToolMessage} */ msg, /** @type {string[] | null} */ senderIds) => {
      addMessageCalls.push(JSON.stringify({ chatId, msg, senderIds }));
    },
  };

  const onReaction = createReactionHandler({
    store: /** @type {any} */ (mockStore),
    executeActionFn: async () => ({ result: "action completed successfully" }),
    pendingByMsgKeyId,
    rootDb: testDb,
  });

  const sock = makeSock();
  await onReaction(makeReactionEvent("msg-key-1", "\uD83D\uDC4D"), /** @type {any} */ (sock));

  assert.equal(addMessageCalls.length, 1, "addMessage should be called once");
  const call = JSON.parse(addMessageCalls[0]);
  assert.equal(call.chatId, CHAT_ID);
  assert.equal(call.msg.role, "tool");
  assert.equal(call.msg.tool_id, "call_abc123");
  assert.deepEqual(call.msg.content, [{ type: "text", text: "action completed successfully" }]);
  assert.deepEqual(call.senderIds, ["sender-1"]);
});

it("stores error tool result on execution failure", async () => {
  const pending = makePending({ msg_key_id: "msg-key-2" });
  const pendingByMsgKeyId = new Map([[pending.msg_key_id, pending]]);

  /** @type {string[]} */
  const addMessageCalls = [];
  const mockStore = {
    addMessage: async (/** @type {string} */ chatId, /** @type {ToolMessage} */ msg, /** @type {string[] | null} */ senderIds) => {
      addMessageCalls.push(JSON.stringify({ chatId, msg, senderIds }));
    },
  };

  const onReaction = createReactionHandler({
    store: /** @type {any} */ (mockStore),
    executeActionFn: async () => { throw new Error("something broke"); },
    pendingByMsgKeyId,
    rootDb: testDb,
  });

  const sock = makeSock();
  await onReaction(makeReactionEvent("msg-key-2", "\uD83D\uDC4D"), /** @type {any} */ (sock));

  assert.equal(addMessageCalls.length, 1, "addMessage should be called once for error");
  const call = JSON.parse(addMessageCalls[0]);
  assert.equal(call.chatId, CHAT_ID);
  assert.equal(call.msg.role, "tool");
  assert.equal(call.msg.tool_id, "call_abc123");
  assert.deepEqual(call.msg.content, [{ type: "text", text: "Error executing testAction: something broke" }]);
});

it("stores rejection tool result", async () => {
  const pending = makePending({ msg_key_id: "msg-key-3" });
  const pendingByMsgKeyId = new Map([[pending.msg_key_id, pending]]);

  /** @type {string[]} */
  const addMessageCalls = [];
  const mockStore = {
    addMessage: async (/** @type {string} */ chatId, /** @type {ToolMessage} */ msg, /** @type {string[] | null} */ senderIds) => {
      addMessageCalls.push(JSON.stringify({ chatId, msg, senderIds }));
    },
  };

  const executeCalled = { value: false };
  const onReaction = createReactionHandler({
    store: /** @type {any} */ (mockStore),
    executeActionFn: async () => { executeCalled.value = true; return { result: "nope" }; },
    pendingByMsgKeyId,
    rootDb: testDb,
  });

  const sock = makeSock();
  await onReaction(makeReactionEvent("msg-key-3", "\uD83D\uDC4E"), /** @type {any} */ (sock));

  assert.equal(executeCalled.value, false, "executeAction should NOT be called on rejection");
  assert.equal(addMessageCalls.length, 1, "addMessage should be called once for rejection");
  const call = JSON.parse(addMessageCalls[0]);
  assert.equal(call.chatId, CHAT_ID);
  assert.equal(call.msg.role, "tool");
  assert.equal(call.msg.tool_id, "call_abc123");
  assert.deepEqual(call.msg.content, [{ type: "text", text: "[action rejected by user]" }]);
});

it("skips tool storage when tool_call_id is null", async () => {
  const pending = makePending({ msg_key_id: "msg-key-4", tool_call_id: null });
  const pendingByMsgKeyId = new Map([[pending.msg_key_id, pending]]);

  /** @type {string[]} */
  const addMessageCalls = [];
  const mockStore = {
    addMessage: async (/** @type {string} */ chatId, /** @type {ToolMessage} */ msg, /** @type {string[] | null} */ senderIds) => {
      addMessageCalls.push(JSON.stringify({ chatId, msg, senderIds }));
    },
  };

  const onReaction = createReactionHandler({
    store: /** @type {any} */ (mockStore),
    executeActionFn: async () => ({ result: "done via !command" }),
    pendingByMsgKeyId,
    rootDb: testDb,
  });

  const sock = makeSock();
  await onReaction(makeReactionEvent("msg-key-4", "\uD83D\uDC4D"), /** @type {any} */ (sock));

  assert.equal(addMessageCalls.length, 0, "addMessage should NOT be called when tool_call_id is null");
});

});
