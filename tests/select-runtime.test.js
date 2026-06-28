import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSelectRuntime } from "../whatsapp/runtime/select-runtime.js";
import { createEncryptedPollVote, RAW_LID_POLL_FIXTURE } from "./poll-vote-fixtures.js";

/**
 * Create a mock socket that captures poll payloads.
 * @returns {{
 *   sock: WhatsAppPollSocketPort;
 *   sentMessages: Array<{ chatId: string, message: Record<string, unknown> }>;
 * }}
 */
function createMockSock() {
  /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
  const sentMessages = [];

  /** @type {WhatsAppPollSocketPort} */
  const sock = {
    user: { id: "bot@s.whatsapp.net" },
    async sendMessage(chatId, message) {
      sentMessages.push({ chatId, message });
      if ("react" in message) {
        return undefined;
      }
      const rawValues = /** @type {{ poll?: { values?: unknown } }} */ (message).poll?.values;
      const values = Array.isArray(rawValues) ? rawValues : [];
      return /** @type {BaileysMessage} */ ({
        key: {
          id: "poll-1",
          remoteJid: chatId,
        },
        message: {
          pollCreationMessageV3: {
            options: values
              .filter((value) => typeof value === "string")
              .map((value) => ({ optionName: value })),
          },
        },
      });
    },
  };

  return {
    sock,
    sentMessages,
  };
}

/**
 * @param {Record<string, unknown>} message
 * @returns {{ values: string[], selectableCount?: number }}
 */
function getPollPayload(message) {
  const poll = message.poll;
  assert.ok(poll && typeof poll === "object", "expected poll payload");
  const values = /** @type {{ values?: unknown, selectableCount?: unknown }} */ (poll).values;
  assert.ok(Array.isArray(values), "expected poll values array");
  return {
    values: values.filter((value) => typeof value === "string"),
    selectableCount: typeof /** @type {{ selectableCount?: unknown }} */ (poll).selectableCount === "number"
      ? /** @type {{ selectableCount: number }} */ (poll).selectableCount
      : undefined,
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

    const poll = getPollPayload(pollMessage.message);
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

  it("commits multi-select polls 3 seconds after the last vote", async () => {
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

    const poll = getPollPayload(pollMessage.message);
    assert.equal(poll.selectableCount, 2);
    assert.deepEqual(poll.values, ["✅ commands", "thinking"]);

    let resolved = false;
    void selectionPromise.then(() => {
      resolved = true;
    });

    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: [poll.values[0]],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(resolved, false, "multi-select should stay open after a vote");
    assert.equal(sentMessages.length, 2, "no settlement effect should be sent before the idle timeout");

    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: poll.values,
    });
    await new Promise((resolve) => setTimeout(resolve, 2900));
    assert.equal(resolved, false, "a new vote should reset the idle commit timer");

    assert.deepEqual(await selectionPromise, { kind: "selected", ids: ["commands", "thinking"] });
    assert.deepEqual(sentMessages[sentMessages.length - 1]?.message, {
      delete: { id: "poll-1", remoteJid: "chat-1" },
    });
  });

  it("treats a select-then-deselect cycle as a no-op for multi-select polls", async () => {
    const registry = createSelectRuntime();
    const { sock, sentMessages } = createMockSock();
    const selectMany = registry.createSelectMany(sock, "chat-1");

    const selectionPromise = selectMany(
      "Pick any",
      [
        { id: "commands", label: "commands" },
        { id: "thinking", label: "thinking" },
      ],
      { deleteOnSelect: true },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: ["thinking"],
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    registry.handlePollVote({
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 2900));

    assert.deepEqual(await selectionPromise, { kind: "unchanged" });
    assert.deepEqual(sentMessages[sentMessages.length - 1]?.message, {
      delete: { id: "poll-1", remoteJid: "chat-1" },
    });
  });

  it("resolves decrypted poll updates delivered on messages.update", async () => {
    const registry = createSelectRuntime();
    const { sock, sentMessages } = createMockSock();
    const selectMany = registry.createSelectMany(sock, "chat-1");

    const selectionPromise = selectMany(
      "Pick any",
      [
        { id: "commands", label: "commands" },
        { id: "thinking", label: "thinking" },
      ],
      { deleteOnSelect: true },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pollMessage = sentMessages.find((entry) => "poll" in entry.message);
    assert.ok(pollMessage, "expected selectMany() to send a poll message");

    const poll = getPollPayload(pollMessage.message);
    assert.equal(poll.values[0], "commands");

    const selectedOptionHash = createHash("sha256").update(poll.values[0]).digest();
    const pollVoteEvent = await registry.resolvePollUpdate({
      key: { id: "poll-1", remoteJid: "chat-1" },
      update: {
        pollUpdates: [{
          pollUpdateMessageKey: {
            id: "vote-1",
            remoteJid: "chat-1",
            participant: "user@s.whatsapp.net",
          },
          vote: { selectedOptions: [selectedOptionHash] },
        }],
      },
    }, sock);

    assert.deepEqual(pollVoteEvent, {
      chatId: "chat-1",
      pollMsgId: "poll-1",
      selectedOptions: ["commands"],
    });
    assert.equal(registry.handlePollVote(pollVoteEvent), true);

    assert.deepEqual(await selectionPromise, { kind: "selected", ids: ["commands"] });
    assert.deepEqual(sentMessages[sentMessages.length - 1]?.message, {
      delete: { id: "poll-1", remoteJid: "chat-1" },
    });
  });

  it("decrypts raw LID poll votes whose creation key carries the bot LID participant", async () => {
    const registry = createSelectRuntime();
    const {
      chatId,
      pollMsgId,
      botPhoneJid,
      botLidJid,
      voterLidJid,
      voterPhoneJid,
      selectedOption,
      pollEncKey,
      encIv,
    } = RAW_LID_POLL_FIXTURE;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {WhatsAppPollSocketPort} */
    const sock = {
      user: { id: botPhoneJid },
      /** @param {string} targetChatId @param {any} message */
      async sendMessage(targetChatId, message) {
        sentMessages.push({ chatId: targetChatId, message });
        if ("react" in message) {
          return undefined;
        }
        const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
        return /** @type {BaileysMessage} */ ({
          key: { id: pollMsgId, remoteJid: targetChatId, fromMe: true },
          message: {
            messageContextInfo: {
              messageSecret: pollEncKey,
            },
            pollCreationMessageV3: {
              name: "When should the bot reply in group chats?",
              options: values
                .filter((value) => typeof value === "string")
                .map((value) => ({ optionName: value })),
              selectableOptionsCount: 1,
            },
          },
        });
      },
    };
    const select = registry.createSelect(sock, chatId);

    const selectionPromise = select("When should the bot reply in group chats?", [
      { id: "any", label: "any" },
      { id: "mention+reply", label: "mention+reply" },
      { id: "mention", label: "mention" },
    ], { currentId: "any", deleteOnSelect: true });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pollVoteEvent = await registry.resolvePollVoteMessage(
      /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
        key: {
          remoteJid: chatId,
          fromMe: false,
          id: "VOTE-LID-1",
          participant: voterLidJid,
          participantAlt: voterPhoneJid,
          addressingMode: "lid",
        },
        messageTimestamp: 1782318719,
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              remoteJid: chatId,
              fromMe: true,
              id: pollMsgId,
              participant: botLidJid,
            },
            vote: createEncryptedPollVote({
              pollMsgId,
              pollCreatorJid: botLidJid,
              voterJid: voterLidJid,
              pollEncKey,
              encIv,
              selectedOption,
            }),
            senderTimestampMs: "1782318719966",
          },
        },
      })),
      sock,
    );

    assert.deepEqual(pollVoteEvent, {
      chatId,
      pollMsgId,
      selectedOptions: [selectedOption],
    });
    assert.equal(registry.handlePollVote(pollVoteEvent), true);
    assert.equal(await selectionPromise, "any");
  });

  it("decrypts raw LID poll votes encrypted for the participantAlt author", async () => {
    const registry = createSelectRuntime();
    const {
      chatId,
      pollMsgId,
      botPhoneJid,
      botLidJid,
      voterLidJid,
      voterPhoneJid,
      selectedOption,
      pollEncKey,
      encIv,
    } = RAW_LID_POLL_FIXTURE;
    /** @type {WhatsAppPollSocketPort} */
    const sock = {
      user: { id: botPhoneJid, lid: botLidJid.replace("@lid", ":32@lid") },
      /** @param {string} targetChatId @param {any} message */
      async sendMessage(targetChatId, message) {
        if ("react" in message) {
          return undefined;
        }
        const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
        return /** @type {BaileysMessage} */ ({
          key: { id: pollMsgId, remoteJid: targetChatId, fromMe: true },
          message: {
            messageContextInfo: {
              messageSecret: pollEncKey,
            },
            pollCreationMessageV3: {
              name: "When should the bot reply in group chats?",
              options: values
                .filter((value) => typeof value === "string")
                .map((value) => ({ optionName: value })),
              selectableOptionsCount: 1,
            },
          },
        });
      },
    };
    const select = registry.createSelect(sock, chatId);

    const selectionPromise = select("When should the bot reply in group chats?", [
      { id: "any", label: "any" },
      { id: "mention+reply", label: "mention+reply" },
      { id: "mention", label: "mention" },
    ], { currentId: "any", deleteOnSelect: true });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pollVoteEvent = await registry.resolvePollVoteMessage(
      /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
        key: {
          remoteJid: chatId,
          fromMe: false,
          id: "VOTE-LID-ALT-1",
          participant: voterLidJid,
          participantAlt: voterPhoneJid,
          addressingMode: "lid",
        },
        messageTimestamp: 1782320253,
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              remoteJid: chatId,
              fromMe: true,
              id: pollMsgId,
              participant: botLidJid,
            },
            vote: createEncryptedPollVote({
              pollMsgId,
              pollCreatorJid: botLidJid,
              voterJid: voterPhoneJid,
              pollEncKey,
              encIv,
              selectedOption,
            }),
            senderTimestampMs: "1782320253495",
          },
        },
      })),
      sock,
    );

    assert.deepEqual(pollVoteEvent, {
      chatId,
      pollMsgId,
      selectedOptions: [selectedOption],
    });
    assert.equal(registry.handlePollVote(pollVoteEvent), true);
    assert.equal(await selectionPromise, "any");
  });

  it("replays a captured raw LID multi-select vote whose sent poll secret is base64 text", async () => {
    const registry = createSelectRuntime();
    const {
      chatId,
      pollMsgId,
      botPhoneJid,
      botLidJid,
      voterLidJid,
      voterPhoneJid,
      pollEncKey,
      encIv,
    } = RAW_LID_POLL_FIXTURE;
    const selectedOption = "⚪ Show pinned tool status";
    const pollOptions = [
      { id: "pinned_tool_status", label: selectedOption },
      { id: "hide_thinking", label: "🟢 Hide thinking" },
      { id: "hide_file_changes", label: "🟢 Hide file changes" },
      { id: "hide_sub_agent_output", label: "🟢 Hide sub-agent output" },
      { id: "hide_all_extras", label: "⚪ Hide all extras" },
    ];
    /** @type {WhatsAppPollSocketPort} */
    const sock = {
      user: { id: botPhoneJid, lid: botLidJid.replace("@lid", ":32@lid") },
      /** @param {string} targetChatId @param {any} message */
      async sendMessage(targetChatId, message) {
        if ("react" in message) {
          return undefined;
        }
        const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
        return /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
          key: { id: pollMsgId, remoteJid: targetChatId, fromMe: true },
          message: {
            messageContextInfo: {
              messageSecret: pollEncKey.toString("base64"),
            },
            pollCreationMessage: {
              name: "Choose which extra agent progress outputs are shown in chat.",
              options: values
                .filter((value) => typeof value === "string")
                .map((value) => ({ optionName: value })),
              selectableOptionsCount: 5,
            },
          },
          participant: botPhoneJid,
        }));
      },
    };
    const selectMany = registry.createSelectMany(sock, chatId);

    const selectionPromise = selectMany(
      "Choose which extra agent progress outputs are shown in chat.",
      pollOptions,
      { deleteOnSelect: true },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pollVoteEvent = await registry.resolvePollVoteMessage(
      /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
        key: {
          remoteJid: chatId,
          fromMe: false,
          id: "VOTE-LID-CAPTURED-SHAPE-1",
          participant: voterLidJid,
          participantAlt: voterPhoneJid,
          addressingMode: "lid",
        },
        messageTimestamp: 1782322727,
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              remoteJid: chatId,
              fromMe: true,
              id: pollMsgId,
              participant: botLidJid,
            },
            vote: createEncryptedPollVote({
              pollMsgId,
              pollCreatorJid: botLidJid,
              voterJid: voterLidJid,
              pollEncKey,
              encIv,
              selectedOption,
            }),
            senderTimestampMs: "1782322728220",
          },
        },
      })),
      sock,
    );

    assert.deepEqual(pollVoteEvent, {
      chatId,
      pollMsgId,
      selectedOptions: [selectedOption],
    });
    assert.equal(registry.handlePollVote(pollVoteEvent), true);
    assert.deepEqual(await selectionPromise, { kind: "selected", ids: ["pinned_tool_status"] });
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
