import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSelectRuntime } from "../whatsapp/runtime/select-runtime.js";

/**
 * Create a mock socket that captures poll payloads.
 * @returns {{
 *   sock: {
 *     sendMessage: (chatId: string, message: Record<string, unknown>) => Promise<{ key: { id: string, remoteJid: string } } | null>;
 *   };
 *   sentMessages: Array<{ chatId: string, message: Record<string, unknown> }>;
 * }}
 */
function createMockSock() {
  /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
  const sentMessages = [];

  return {
    sock: {
      async sendMessage(chatId, message) {
        sentMessages.push({ chatId, message });
        if ("react" in message) {
          return null;
        }
        return {
          key: {
            id: "poll-1",
            remoteJid: chatId,
          },
        };
      },
    },
    sentMessages,
  };
}

describe("createSelectRuntime", () => {
  it("uses the latest live socket when a select prompt is sent after reconnect", async () => {
    const registry = createSelectRuntime();
    const oldSocket = createMockSock();
    const newSocket = createMockSock();
    /** @type {typeof oldSocket.sock | null} */
    let currentSocket = oldSocket.sock;

    const select = registry.createSelect(() => currentSocket, "chat-1");

    currentSocket = newSocket.sock;
    const selectionPromise = select("Pick one", ["First", "Second"]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(oldSocket.sentMessages.length, 0);
    assert.equal(newSocket.sentMessages.length, 2, "expected poll and pending reaction on the new socket");

    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: ["First"],
    });

    assert.equal(await selectionPromise, "First");
  });

  it("uses the latest live socket for select settlement effects after reconnect", async () => {
    const registry = createSelectRuntime();
    const oldSocket = createMockSock();
    const newSocket = createMockSock();
    /** @type {typeof oldSocket.sock | null} */
    let currentSocket = oldSocket.sock;

    const select = registry.createSelect(() => currentSocket, "chat-1");
    const selectionPromise = select("Pick one", ["First", "Second"]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    currentSocket = newSocket.sock;
    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: ["First"],
    });

    assert.equal(await selectionPromise, "First");
    assert.equal(oldSocket.sentMessages.length, 2, "original socket should only have the initial poll send");
    assert.equal(newSocket.sentMessages.length, 1, "settlement effect should be sent on the replacement socket");
    assert.deepEqual(newSocket.sentMessages[0]?.message, {
      react: { text: "", key: { id: "poll-1", remoteJid: "chat-1" } },
    });
  });

  it("preserves option identity when labels are duplicated", async () => {
    const registry = createSelectRuntime();
    const { sock, sentMessages } = createMockSock();
    const select = registry.createSelect(sock, "chat-1");

    const selectionPromise = select("Pick one", [
      { id: "first", label: "Same label" },
      { id: "second", label: "Same label" },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pollMessage = sentMessages.find((entry) => "poll" in entry.message);
    assert.ok(pollMessage, "expected select() to send a poll message");

    const poll = pollMessage.message.poll;
    assert.ok(poll && typeof poll === "object", "expected poll payload");
    assert.ok(Array.isArray(poll.values), "expected poll values array");
    assert.equal(poll.values.length, 2);
    assert.notEqual(
      poll.values[0],
      poll.values[1],
      "duplicate labels should be disambiguated before sending the poll",
    );

    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: [poll.values[0]],
    });

    assert.equal(await selectionPromise, "first");
  });

  it("supports multi-select polls and resolves all selected ids", async () => {
    const registry = createSelectRuntime();
    const { sock, sentMessages } = createMockSock();
    const selectMany = registry.createSelectMany(sock, "chat-1");

    const selectionPromise = selectMany(
      "Pick any",
      [
        { id: "commands", label: "commands" },
        { id: "thinking", label: "thinking" },
      ],
      { currentIds: ["commands"], deleteOnSelect: true },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pollMessage = sentMessages.find((entry) => "poll" in entry.message);
    assert.ok(pollMessage, "expected selectMany() to send a poll message");

    const poll = pollMessage.message.poll;
    assert.ok(poll && typeof poll === "object", "expected poll payload");
    assert.ok(Array.isArray(poll.values), "expected poll values array");
    assert.equal(poll.selectableCount, 2);
    assert.deepEqual(poll.values, ["✅ commands", "thinking"]);

    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: poll.values,
    });

    assert.deepEqual(await selectionPromise, ["commands", "thinking"]);
    assert.deepEqual(sentMessages[sentMessages.length - 1]?.message, {
      delete: { id: "poll-1", remoteJid: "chat-1" },
    });
  });

  it("clear() resolves pending selects without sending cancellation reactions", async () => {
    const registry = createSelectRuntime();
    const { sock, sentMessages } = createMockSock();
    const select = registry.createSelect(sock, "chat-1");

    const selectionPromise = select("Pick one", ["First", "Second"]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sentMessages.length, 2, "expected poll and initial pending reaction");
    registry.clear();

    assert.equal(await selectionPromise, "");
    assert.equal(registry.size, 0, "pending selects should be cleared");
    assert.equal(
      sentMessages.length,
      2,
      "clear() should not emit additional WhatsApp messages during teardown",
    );
  });
});
