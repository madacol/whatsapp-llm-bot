import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleHarnessSessionCommand } from "../harnesses/session-commands.js";

/**
 * @returns {ExecuteActionContext}
 */
function createContext() {
  return /** @type {ExecuteActionContext} */ ({
    chatId: "chat-1",
    senderIds: [],
    content: [],
    getIsAdmin: async () => true,
    send: async () => undefined,
    reply: async () => undefined,
    reactToMessage: async () => {},
    select: async () => "",
    confirm: async () => true,
  });
}

/**
 * @param {OutboundEvent} event
 * @returns {string}
 */
function getReplyText(event) {
  assert.equal(event.kind, "content");
  return typeof event.content === "string" ? event.content : JSON.stringify(event.content);
}

describe("handleHarnessSessionCommand", () => {
  it("clears the active session through session control primitives", async () => {
    /** @type {string[]} */
    const calls = [];
    /** @type {string[]} */
    const replies = [];
    const context = createContext();
    context.reply = async (event) => {
      replies.push(getReplyText(event));
      return undefined;
    };

    const handled = await handleHarnessSessionCommand({
      command: "clear",
      chatId: "chat-1",
      context,
      cancelActiveQuery: async () => {
        calls.push("cancel");
        return true;
      },
      sessionControl: {
        archive: async (chatId) => {
          calls.push(`archive:${chatId}`);
        },
        getHistory: async () => [],
        restore: async () => null,
      },
    });

    assert.equal(handled, true);
    assert.deepEqual(calls, ["cancel", "archive:chat-1"]);
    assert.ok(replies[0]?.includes("Session cleared"));
  });

  it("restores a selected session from history", async () => {
    /** @type {string[]} */
    const calls = [];
    /** @type {string[]} */
    const replies = [];
    /** @type {SelectOption[]} */
    let seenOptions = [];
    const context = createContext();
    context.reply = async (event) => {
      replies.push(getReplyText(event));
      return undefined;
    };
    context.select = async (_question, options) => {
      seenOptions = options;
      return "sess-newer";
    };

    const handled = await handleHarnessSessionCommand({
      command: "resume",
      chatId: "chat-1",
      context,
      cancelActiveQuery: async () => false,
      sessionControl: {
        archive: async (chatId) => {
          calls.push(`archive:${chatId}`);
          return null;
        },
        getHistory: async () => [
          { id: "sess-older", kind: "claude-sdk", cleared_at: "2026-03-19T20:00:00.000Z", title: "Planning refactor" },
          { id: "sess-newer", kind: "codex", cleared_at: "2026-03-19T21:00:00.000Z", title: "Fixing WhatsApp parser" },
        ],
        restore: async (chatId, index) => {
          calls.push(`restore:${chatId}:${index}`);
          return { id: "sess-newer", kind: "codex", cleared_at: "2026-03-19T21:00:00.000Z", title: "Fixing WhatsApp parser" };
        },
      },
      now: () => new Date("2026-03-19T22:00:00.000Z"),
    });

    assert.equal(handled, true);
    assert.deepEqual(calls, ["archive:chat-1", "restore:chat-1:sess-newer"]);
    assert.equal(seenOptions[0]?.label, "Fixing WhatsApp parser (1h ago)");
    assert.equal(seenOptions[0]?.id, "sess-newer");
    assert.ok(replies[0]?.includes("Session restored"));
    assert.ok(replies[0]?.includes("Fixing WhatsApp parser"));
  });

  it("does not archive or restore anything when resume selection is cancelled", async () => {
    /** @type {string[]} */
    const calls = [];
    /** @type {string[]} */
    const replies = [];
    const context = createContext();
    context.reply = async (event) => {
      replies.push(getReplyText(event));
      return undefined;
    };
    context.select = async () => "cancel";

    const handled = await handleHarnessSessionCommand({
      command: "resume",
      chatId: "chat-1",
      context,
      sessionControl: {
        archive: async (chatId) => {
          calls.push(`archive:${chatId}`);
          return null;
        },
        getHistory: async () => [
          { id: "sess-older", kind: "claude-sdk", cleared_at: "2026-03-19T20:00:00.000Z", title: "Planning refactor" },
        ],
        restore: async (chatId, sessionId) => {
          calls.push(`restore:${chatId}:${sessionId}`);
          return null;
        },
      },
    });

    assert.equal(handled, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(replies, []);
  });
});
