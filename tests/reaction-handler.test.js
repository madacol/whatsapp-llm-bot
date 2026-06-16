process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReactionRuntime as createReactionRegistry } from "../whatsapp/runtime/reaction-runtime.js";

describe("createReactionRegistry", () => {

it("routes reactions to subscribed callbacks", () => {
  const registry = createReactionRegistry();
  /** @type {Array<{ emoji: string; senderId: string; fromMe?: boolean }>} */
  const received = [];

  registry.subscribe("msg-1", (emoji, senderId, metadata) => {
    received.push({ emoji, senderId, ...metadata });
  });

  registry.handleReactions([
    { key: { id: "msg-1", remoteJid: "chat-1" }, reaction: { text: "👁" }, senderId: "user-1", fromMe: true },
  ]);

  assert.equal(received.length, 1);
  assert.equal(received[0].emoji, "👁");
  assert.equal(received[0].senderId, "user-1");
  assert.equal(received[0].fromMe, true);
});

it("does not route reactions to unsubscribed messages", () => {
  const registry = createReactionRegistry();
  /** @type {string[]} */
  const received = [];

  registry.subscribe("msg-1", (emoji) => { received.push(emoji); });

  registry.handleReactions([
    { key: { id: "msg-2", remoteJid: "chat-1" }, reaction: { text: "👍" }, senderId: "user-1" },
  ]);

  assert.equal(received.length, 0);
});

it("observes matched and unmatched reaction delivery", () => {
  /** @type {Array<import("../whatsapp/runtime/reaction-runtime.js").ReactionRuntimeObserverEvent>} */
  const observed = [];
  const registry = createReactionRegistry({ observer: (event) => { observed.push(event); } });

  registry.subscribe("msg-1", () => {});

  registry.handleReactions([
    { key: { id: "msg-1", remoteJid: "chat-1" }, reaction: { text: "👁" }, senderId: "user-1", fromMe: true },
    { key: { id: "msg-2", remoteJid: "chat-1" }, reaction: { text: "👁" }, senderId: "user-1" },
  ]);

  assert.deepEqual(observed, [
    {
      type: "reaction.received",
      messageId: "msg-1",
      remoteJid: "chat-1",
      emoji: "👁",
      senderId: "user-1",
      fromMe: true,
      listenerCount: 1,
    },
    {
      type: "reaction.received",
      messageId: "msg-2",
      remoteJid: "chat-1",
      emoji: "👁",
      senderId: "user-1",
      listenerCount: 0,
    },
  ]);
});

it("unsubscribe stops routing", () => {
  const registry = createReactionRegistry();
  /** @type {string[]} */
  const received = [];

  const unsub = registry.subscribe("msg-1", (emoji) => { received.push(emoji); });
  unsub();

  registry.handleReactions([
    { key: { id: "msg-1", remoteJid: "chat-1" }, reaction: { text: "👁" }, senderId: "user-1" },
  ]);

  assert.equal(received.length, 0);
  assert.equal(registry.size, 0, "should clean up empty listener sets");
});

it("supports multiple subscribers on same message", () => {
  const registry = createReactionRegistry();
  let count = 0;

  registry.subscribe("msg-1", () => { count++; });
  registry.subscribe("msg-1", () => { count++; });

  registry.handleReactions([
    { key: { id: "msg-1", remoteJid: "chat-1" }, reaction: { text: "👁" }, senderId: "user-1" },
  ]);

  assert.equal(count, 2);
  assert.equal(registry.size, 1, "single message entry in map");
});

it("clear removes all subscriptions", () => {
  const registry = createReactionRegistry();
  /** @type {string[]} */
  const received = [];

  registry.subscribe("msg-1", (emoji) => { received.push(emoji); });
  registry.subscribe("msg-2", (emoji) => { received.push(emoji); });

  assert.equal(registry.size, 2);
  registry.clear();
  assert.equal(registry.size, 0);

  registry.handleReactions([
    { key: { id: "msg-1", remoteJid: "chat-1" }, reaction: { text: "👁" }, senderId: "user-1" },
  ]);

  assert.equal(received.length, 0);
});

it("handles batch of reactions across multiple messages", () => {
  const registry = createReactionRegistry();
  /** @type {Array<{ msgId: string; emoji: string }>} */
  const received = [];

  registry.subscribe("msg-1", (emoji) => { received.push({ msgId: "msg-1", emoji }); });
  registry.subscribe("msg-2", (emoji) => { received.push({ msgId: "msg-2", emoji }); });

  registry.handleReactions([
    { key: { id: "msg-1", remoteJid: "chat-1" }, reaction: { text: "👁" }, senderId: "user-1" },
    { key: { id: "msg-2", remoteJid: "chat-1" }, reaction: { text: "👍" }, senderId: "user-2" },
    { key: { id: "msg-3", remoteJid: "chat-1" }, reaction: { text: "❤️" }, senderId: "user-3" },
  ]);

  assert.equal(received.length, 2);
  assert.equal(received[0].msgId, "msg-1");
  assert.equal(received[0].emoji, "👁");
  assert.equal(received[1].msgId, "msg-2");
  assert.equal(received[1].emoji, "👍");
});

});
