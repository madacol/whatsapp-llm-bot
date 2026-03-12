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
  /** @type {Array<{jid: string, content: object}> } */
  const sent = [];
  return {
    sent,
    sendMessage: async (/** @type {string} */ jid, /** @type {object} */ content) => {
      sent.push({ jid, content });
    },
  };
}

/**
 * Build a mock store for reaction handler tests.
 * @param {{ getToolResultReturns?: any }} [opts]
 */
function makeMockStore(opts = {}) {
  const { getToolResultReturns = null } = opts;
  return {
    getToolResultByWaKeyId: async () => getToolResultReturns,
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

it("edits tool-call message with result on react-to-inspect", async () => {
  const toolResult = {
    toolMsg: {
      role: "tool",
      tool_id: "toolu_123",
      tool_name: "Bash",
      wa_key_id: "wa-key-inspect",
      content: [{ type: "text", text: "hello from bash" }],
    },
    chatId: "test-chat@s.whatsapp.net",
  };
  const mockStore = makeMockStore({ getToolResultReturns: toolResult });

  const onReaction = createReactionHandler({
    store: /** @type {any} */ (mockStore),
  });

  const sock = makeSock();
  await onReaction(makeReactionEvent("wa-key-inspect", "👁"), /** @type {any} */ (sock));

  assert.equal(sock.sent.length, 1, "should send one edit message");
  const msg = /** @type {any} */ (sock.sent[0].content);
  assert.ok(msg.edit, "should be an edit message");
  assert.ok(msg.text.includes("hello from bash"), "should contain tool result");
  assert.ok(msg.text.includes("Bash"), "should contain tool name");
});

it("does nothing when no tool result is found", async () => {
  const mockStore = makeMockStore({ getToolResultReturns: null });

  const onReaction = createReactionHandler({
    store: /** @type {any} */ (mockStore),
  });

  const sock = makeSock();
  await onReaction(makeReactionEvent("unknown-key", "👁"), /** @type {any} */ (sock));

  assert.equal(sock.sent.length, 0, "should not send anything");
});

});
