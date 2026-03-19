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

describe("handleHarnessSessionCommand", () => {
  it("clears the active session through session control primitives", async () => {
    /** @type {string[]} */
    const calls = [];
    /** @type {string[]} */
    const replies = [];
    const context = createContext();
    context.reply = async (_source, content) => {
      replies.push(typeof content === "string" ? content : JSON.stringify(content));
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
    const context = createContext();
    context.reply = async (_source, content) => {
      replies.push(typeof content === "string" ? content : JSON.stringify(content));
      return undefined;
    };
    context.select = async () => "0";

    const handled = await handleHarnessSessionCommand({
      command: "resume",
      chatId: "chat-1",
      context,
      cancelActiveQuery: async () => false,
      sessionControl: {
        archive: async (chatId) => {
          calls.push(`archive:${chatId}`);
        },
        getHistory: async () => [
          { id: "sess-older", kind: "claude-sdk", cleared_at: "2026-03-19T20:00:00.000Z" },
          { id: "sess-newer", kind: "codex", cleared_at: "2026-03-19T21:00:00.000Z" },
        ],
        restore: async (chatId, index) => {
          calls.push(`restore:${chatId}:${index}`);
          return { id: "sess-newer", kind: "codex", cleared_at: "2026-03-19T21:00:00.000Z" };
        },
      },
      now: () => new Date("2026-03-19T22:00:00.000Z"),
    });

    assert.equal(handled, true);
    assert.deepEqual(calls, ["archive:chat-1", "restore:chat-1:0"]);
    assert.ok(replies[0]?.includes("Session restored"));
  });
});
