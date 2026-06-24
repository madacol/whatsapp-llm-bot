import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWhatsAppTransport,
  executeCommunityCreate,
  executeCommunityCreateGroup,
  executeGroupLinkedParentLookup,
  executeGroupParticipantLookup,
} from "../whatsapp/create-whatsapp-transport.js";
import { setDb } from "../db.js";
import { initStore } from "../store.js";
import { createTestDb, createWAMessage } from "./helpers.js";
import { agentToolResultEvent, appMessageEvent, assistantOutputEvent, runtimeEvent } from "../outbound-events.js";
import { textUpdate } from "../message-handle-events.js";
import { createRestartCommandHandler } from "../commands/restart-command.js";
import { createRestartAckStore } from "../restart/restart-ack-store.js";
import { deliverPendingRestartAck } from "../restart/restart-ack-delivery.js";
import {
  flushQueuedWhatsAppOutbound,
  sendOrQueueWhatsAppEvent,
} from "../whatsapp/outbound/persistent-queue.js";
import { makeTextMessage } from "../whatsapp/message-payloads.js";
import { createEncryptedPollVote, RAW_LID_POLL_FIXTURE } from "./poll-vote-fixtures.js";

/** @type {import("@electric-sql/pglite").PGlite | null} */
let testDb = null;
/** @type {import("../store.js").Store | null} */
let testStore = null;
const originalOutboundQueuePersistDelayMs = process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
const originalOutboundQueueReplayDelayMs = process.env.MADABOT_OUTBOUND_QUEUE_REPLAY_DELAY_MS;
const originalMasterId = process.env.MASTER_ID;

before(async () => {
  process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = "0";
  process.env.MADABOT_OUTBOUND_QUEUE_REPLAY_DELAY_MS = "0";
  process.env.MASTER_ID = "master-user";
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  testStore = await initStore(testDb);
});

after(() => {
  if (originalOutboundQueuePersistDelayMs === undefined) {
    delete process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
  } else {
    process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = originalOutboundQueuePersistDelayMs;
  }
  if (originalOutboundQueueReplayDelayMs === undefined) {
    delete process.env.MADABOT_OUTBOUND_QUEUE_REPLAY_DELAY_MS;
  } else {
    process.env.MADABOT_OUTBOUND_QUEUE_REPLAY_DELAY_MS = originalOutboundQueueReplayDelayMs;
  }
  if (originalMasterId === undefined) {
    delete process.env.MASTER_ID;
  } else {
    process.env.MASTER_ID = originalMasterId;
  }
});

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} chatId
 * @returns {Promise<Array<{ id: number, chat_id: string, payload_json: unknown }>>}
 */
async function getQueuedRows(db, chatId) {
  const { rows } = await db.sql`
    SELECT id, chat_id, payload_json
    FROM whatsapp_outbound_queue
    WHERE chat_id = ${chatId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    chat_id: String(row.chat_id),
    payload_json: row.payload_json,
  }));
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} chatId
 * @returns {Promise<Array<{ original_queue_id: number, chat_id: string, reason: string }>>}
 */
async function getDeadLetterRows(db, chatId) {
  const { rows } = await db.sql`
    SELECT original_queue_id, chat_id, reason
    FROM whatsapp_outbound_dead_letter
    WHERE chat_id = ${chatId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    original_queue_id: Number(row.original_queue_id),
    chat_id: String(row.chat_id),
    reason: String(row.reason),
  }));
}

/**
 * @param {import("@electric-sql/pglite").PGlite} db
 * @param {string} chatId
 * @returns {Promise<Array<{ source_event_type: string, state: string, last_error: string | null }>>}
 */
async function getIngressRows(db, chatId) {
  const { rows } = await db.sql`
    SELECT source_event_type, state, last_error
    FROM whatsapp_ingress_journal
    WHERE chat_id = ${chatId}
    ORDER BY id ASC
  `;
  return rows.map((row) => ({
    source_event_type: String(row.source_event_type),
    state: String(row.state),
    last_error: row.last_error === null ? null : String(row.last_error),
  }));
}

function createBaileysGroupMetadataAttrsError() {
  const error = new TypeError("Cannot read properties of undefined (reading 'attrs')");
  error.stack = [
    `${error.name}: ${error.message}`,
    "    at extractGroupMetadata (node_modules/@whiskeysockets/baileys/lib/Socket/groups.js:286:27)",
    "    at groupMetadata (node_modules/@whiskeysockets/baileys/lib/Socket/groups.js:20:16)",
    "    at async node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js:479:41",
  ].join("\n");
  return error;
}

function createBaileysRateOverlimitError() {
  const error = new Error("rate-overlimit");
  error.stack = [
    `${error.name}: ${error.message}`,
    "    at assertNodeErrorFree (node_modules/@whiskeysockets/baileys/lib/WABinary/generic-utils.js:57:15)",
    "    at query (node_modules/@whiskeysockets/baileys/lib/Socket/socket.js:134:13)",
    "    at async groupMetadata (node_modules/@whiskeysockets/baileys/lib/Socket/groups.js:20:24)",
    "    at async node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js:506:41",
  ].join("\n");
  return Object.assign(error, {
    data: 429,
    isBoom: true,
    isServer: true,
    output: {
      statusCode: 500,
      payload: {
        statusCode: 500,
        error: "Internal Server Error",
        message: "An internal server error occurred",
      },
      headers: {},
    },
  });
}

async function waitForTransportBackgroundWork() {
  for (let i = 0; i < 5; i += 1) {
    await delay(0);
  }
}

/**
 * @param {() => boolean} predicate
 * @param {string} failureMessage
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForCondition(predicate, failureMessage, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail(failureMessage);
}

describe("WhatsApp transport community creation", () => {
  it("buffers streamed LLM chunks in WhatsApp until completion", async () => {
    const chatId = `stream-buffer-${Date.now()}`;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));
    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: assistantOutputEvent([{ type: "markdown", text: "Hel" }], {
        stream: { id: "assistant-1", status: "partial" },
      }),
    });
    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: assistantOutputEvent([{ type: "markdown", text: "lo" }], {
        stream: { id: "assistant-1", status: "partial" },
      }),
    });
    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: assistantOutputEvent([{ type: "markdown", text: " wor" }], {
        stream: { id: "assistant-1", status: "partial" },
      }),
    });
    assert.deepEqual(sentMessages, []);

    await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: assistantOutputEvent([{ type: "markdown", text: "Hello world" }], {
        stream: { id: "assistant-1", status: "final" },
      }),
    });
    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 Hello world"),
    }]);
  });

  it("coalesces rapid same-chat turn messages before invoking the app handler", async () => {
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {ChatTurn[]} */
    const turns = [];
    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendPresenceUpdate: async () => {},
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
    });

    await transport.start(async (turn) => {
      turns.push(turn);
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ text: "first", senderId: "rapid-user" }),
          createWAMessage({ text: "second", senderId: "rapid-user" }),
        ],
      },
    });
    await delay(25);

    assert.equal(turns.length, 1);
    assert.deepEqual(
      turns[0].content.filter((block) => block.type === "text").map((block) => block.text),
      ["first", "second"],
    );
  });

  it("resolves selectMany poll votes delivered through messages.update", async () => {
    const chatId = `poll-update-select-${Date.now()}@g.us`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ id: string, chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {(value: unknown) => void} */
    let resolveReply = () => {};
    const replyHandled = new Promise((resolve) => {
      resolveReply = resolve;
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        const id = `sent-${sentMessages.length + 1}`;
        sentMessages.push({ id, chatId: targetChatId, message });
        if ("poll" in message) {
          const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
          return {
            key: { id, remoteJid: targetChatId, fromMe: true },
            message: {
              pollCreationMessageV3: {
                options: values
                  .filter((value) => typeof value === "string")
                  .map((value) => ({ optionName: value })),
              },
            },
          };
        }
        return { key: { id, remoteJid: targetChatId, fromMe: true } };
      },
      sendPresenceUpdate: async () => {},
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
        },
      },
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
    });

    await transport.start(async (turn) => {
      const selection = await turn.io.selectMany(
        "Pick outputs",
        [{ id: "toolStatus", label: "⚪ Show pinned tool status" }],
        { deleteOnSelect: true },
      );
      await turn.io.reply(assistantOutputEvent([{ type: "markdown", text: JSON.stringify(selection) }]));
      resolveReply(selection);
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({ "connection.update": { connection: "open" } });
    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ chatId, text: "choose", senderId: "poll-user" }),
        ],
      },
    });

    await waitForCondition(
      () => sentMessages.some((entry) => "poll" in entry.message),
      `Expected selectMany to send a poll, got ${JSON.stringify(sentMessages)}`,
    );
    const pollEntry = sentMessages.find((entry) => "poll" in entry.message);
    assert.ok(pollEntry, "expected poll entry");
    const poll = pollEntry.message.poll;
    assert.ok(poll && typeof poll === "object" && Array.isArray(poll.values), "expected poll values");
    const selectedOption = poll.values[0];
    assert.equal(selectedOption, "⚪ Show pinned tool status");

    await processEvents({
      "messages.update": [{
        key: { id: pollEntry.id, remoteJid: chatId, fromMe: true },
        update: {
          pollUpdates: [{
            pollUpdateMessageKey: {
              id: "vote-1",
              remoteJid: chatId,
              participant: "poll-user@s.whatsapp.net",
            },
            vote: {
              selectedOptions: [createHash("sha256").update(selectedOption).digest()],
            },
          }],
        },
      }],
    });

    const result = await Promise.race([
      replyHandled,
      delay(5_000).then(() => "timeout"),
    ]);
    assert.deepEqual(result, { kind: "selected", ids: ["toolStatus"] });
    assert.ok(
      sentMessages.some((entry) => "delete" in entry.message && /** @type {{ delete?: { id?: string } }} */ (entry.message).delete?.id === pollEntry.id),
      `Expected poll delete settlement, got ${JSON.stringify(sentMessages)}`,
    );
    assert.ok(
      sentMessages.some((entry) => typeof entry.message.text === "string" && entry.message.text.includes("\"toolStatus\"")),
      `Expected selected reply, got ${JSON.stringify(sentMessages)}`,
    );
  });

  it("resolves raw LID poll votes delivered through messages.upsert", async () => {
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
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ id: string, chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {(value: unknown) => void} */
    let resolveReply = () => {};
    const replyHandled = new Promise((resolve) => {
      resolveReply = resolve;
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: botPhoneJid, lid: botLidJid.replace("@lid", ":32@lid") },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        const id = "poll" in message ? pollMsgId : `sent-${sentMessages.length + 1}`;
        sentMessages.push({ id, chatId: targetChatId, message });
        if ("poll" in message) {
          const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
          return {
            key: { id, remoteJid: targetChatId, fromMe: true },
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
          };
        }
        return { key: { id, remoteJid: targetChatId, fromMe: true } };
      },
      sendPresenceUpdate: async () => {},
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
        },
      },
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
    });

    await transport.start(async (turn) => {
      const selection = await turn.io.select(
        "When should the bot reply in group chats?",
        [
          { id: "any", label: "any" },
          { id: "mention+reply", label: "mention+reply" },
          { id: "mention", label: "mention" },
        ],
        { currentId: "any", deleteOnSelect: true },
      );
      await turn.io.reply(assistantOutputEvent([{ type: "markdown", text: selection }]));
      resolveReply(selection);
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({ "connection.update": { connection: "open" } });
    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ chatId, text: "choose", senderId: "poll-user" }),
        ],
      },
    });

    await waitForCondition(
      () => sentMessages.some((entry) => "poll" in entry.message),
      `Expected select() to send a poll, got ${JSON.stringify(sentMessages)}`,
    );

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          /** @type {import("@whiskeysockets/baileys").WAMessage} */ ({
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
                  voterJid: voterPhoneJid,
                  pollEncKey,
                  encIv,
                  selectedOption,
                }),
                senderTimestampMs: "1782318719966",
              },
            },
          }),
        ],
      },
    });

    const result = await Promise.race([
      replyHandled,
      delay(5_000).then(() => "timeout"),
    ]);
    assert.equal(result, "any");
    assert.ok(
      sentMessages.some((entry) => "delete" in entry.message && /** @type {{ delete?: { id?: string } }} */ (entry.message).delete?.id === pollMsgId),
      `Expected poll delete settlement, got ${JSON.stringify(sentMessages)}`,
    );
    assert.ok(
      sentMessages.some((entry) => entry.message.text === "🤖 any"),
      `Expected selected reply, got ${JSON.stringify(sentMessages)}`,
    );
  });

  it("replays captured-shape raw LID selectMany poll votes delivered through messages.upsert", async () => {
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
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ id: string, chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {(value: unknown) => void} */
    let resolveReply = () => {};
    const replyHandled = new Promise((resolve) => {
      resolveReply = resolve;
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: botPhoneJid, lid: botLidJid.replace("@lid", ":32@lid") },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        const id = "poll" in message ? pollMsgId : `sent-${sentMessages.length + 1}`;
        sentMessages.push({ id, chatId: targetChatId, message });
        if ("poll" in message) {
          const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
          return {
            key: { id, remoteJid: targetChatId, fromMe: true },
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
          };
        }
        return { key: { id, remoteJid: targetChatId, fromMe: true } };
      },
      sendPresenceUpdate: async () => {},
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
        },
      },
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
    });

    await transport.start(async (turn) => {
      const selection = await turn.io.selectMany(
        "Choose which extra agent progress outputs are shown in chat.",
        pollOptions,
        { deleteOnSelect: true },
      );
      await turn.io.reply(assistantOutputEvent([{ type: "markdown", text: JSON.stringify(selection) }]));
      resolveReply(selection);
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({ "connection.update": { connection: "open" } });
    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ chatId, text: "choose", senderId: "poll-user" }),
        ],
      },
    });

    await waitForCondition(
      () => sentMessages.some((entry) => "poll" in entry.message),
      `Expected selectMany to send a poll, got ${JSON.stringify(sentMessages)}`,
    );

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          /** @type {import("@whiskeysockets/baileys").WAMessage} */ ({
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
          }),
        ],
      },
    });

    const result = await Promise.race([
      replyHandled,
      delay(5_000).then(() => "timeout"),
    ]);
    assert.deepEqual(result, { kind: "selected", ids: ["pinned_tool_status"] });
    assert.ok(
      sentMessages.some((entry) => "delete" in entry.message && /** @type {{ delete?: { id?: string } }} */ (entry.message).delete?.id === pollMsgId),
      `Expected poll delete settlement, got ${JSON.stringify(sentMessages)}`,
    );
    assert.ok(
      sentMessages.some((entry) => typeof entry.message.text === "string" && entry.message.text.includes("pinned_tool_status")),
      `Expected selected reply, got ${JSON.stringify(sentMessages)}`,
    );
  });

  it("refreshes sent poll secrets from bot-authored poll echoes before raw vote decrypt", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const {
      pollMsgId,
      botPhoneJid,
      botLidJid,
      voterLidJid,
      voterPhoneJid,
      pollEncKey,
      encIv,
    } = RAW_LID_POLL_FIXTURE;
    const chatId = `poll-echo-secret-${Date.now()}@g.us`;
    const staleSendSecret = Buffer.from("ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100", "hex");
    const selectedOption = "⚪ Show pinned tool status";
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ id: string, chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {(value: unknown) => void} */
    let resolveReply = () => {};
    const replyHandled = new Promise((resolve) => {
      resolveReply = resolve;
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: botPhoneJid, lid: botLidJid.replace("@lid", ":32@lid") },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        const id = "poll" in message ? pollMsgId : `sent-${sentMessages.length + 1}`;
        sentMessages.push({ id, chatId: targetChatId, message });
        if ("poll" in message) {
          const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
          return {
            key: { id, remoteJid: targetChatId, fromMe: true },
            message: {
              messageContextInfo: {
                messageSecret: staleSendSecret,
              },
              pollCreationMessage: {
                name: "Choose which extra agent progress outputs are shown in chat.",
                options: values
                  .filter((value) => typeof value === "string")
                  .map((value) => ({ optionName: value })),
                selectableOptionsCount: 5,
              },
            },
          };
        }
        return { key: { id, remoteJid: targetChatId, fromMe: true } };
      },
      sendPresenceUpdate: async () => {},
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
        },
      },
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await transport.start(async (turn) => {
      const selection = await turn.io.selectMany(
        "Choose which extra agent progress outputs are shown in chat.",
        [
          { id: "pinned_tool_status", label: selectedOption },
          { id: "hide_thinking", label: "🟢 Hide thinking" },
          { id: "hide_file_changes", label: "🟢 Hide file changes" },
        ],
        { deleteOnSelect: true },
      );
      await turn.io.reply(assistantOutputEvent([{ type: "markdown", text: JSON.stringify(selection) }]));
      resolveReply(selection);
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({ "connection.update": { connection: "open" } });
    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ chatId, text: "choose", senderId: "poll-user" }),
        ],
      },
    });

    await waitForCondition(
      () => sentMessages.some((entry) => "poll" in entry.message),
      `Expected selectMany to send a poll, got ${JSON.stringify(sentMessages)}`,
    );

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          /** @type {import("@whiskeysockets/baileys").WAMessage} */ ({
            key: {
              remoteJid: chatId,
              fromMe: true,
              id: pollMsgId,
            },
            message: {
              messageContextInfo: {
                messageSecret: pollEncKey.toString("base64"),
              },
              pollCreationMessage: {
                name: "Choose which extra agent progress outputs are shown in chat.",
                options: [
                  { optionName: selectedOption },
                  { optionName: "🟢 Hide thinking" },
                  { optionName: "🟢 Hide file changes" },
                ],
                selectableOptionsCount: 3,
              },
            },
            messageTimestamp: "1782323910",
            status: "PENDING",
            participant: botPhoneJid,
          }),
        ],
      },
    });
    await waitForTransportBackgroundWork();

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          /** @type {import("@whiskeysockets/baileys").WAMessage} */ ({
            key: {
              remoteJid: chatId,
              fromMe: false,
              id: "VOTE-LID-ECHO-SECRET-1",
              participant: voterLidJid,
              participantAlt: voterPhoneJid,
              addressingMode: "lid",
            },
            messageTimestamp: 1782323913,
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
                senderTimestampMs: "1782323914269",
              },
            },
          }),
        ],
      },
    });

    const result = await Promise.race([
      replyHandled,
      delay(5_000).then(() => "timeout"),
    ]);
    assert.deepEqual(result, { kind: "selected", ids: ["pinned_tool_status"] });
    assert.ok(
      sentMessages.some((entry) => "delete" in entry.message && /** @type {{ delete?: { id?: string } }} */ (entry.message).delete?.id === pollMsgId),
      `Expected poll delete settlement, got ${JSON.stringify(sentMessages)}`,
    );

    await waitForTransportBackgroundWork();
    const ingressRows = await getIngressRows(testDb, chatId);
    assert.deepEqual(
      ingressRows.map((row) => [row.source_event_type, row.state, row.last_error]),
      [
        ["messages.upsert", "done", null],
        ["messages.upsert", "ignored", null],
        ["messages.upsert", "done", null],
      ],
    );
  });

  it("replays an inbound message after the app handler fails before acknowledgement", async () => {
    if (!testStore) {
      throw new Error("Expected test store to be initialized");
    }

    const chatId = `inbound-retry-${Date.now()}@g.us`;
    /** @type {Array<ChatTurn>} */
    const deliveredTurns = [];
    let attempts = 0;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let firstProcessEvents = null;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let secondProcessEvents = null;

    const firstSocket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          firstProcessEvents = handler;
        },
      },
      sendPresenceUpdate: async () => {},
    }));
    const firstTransport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(firstSocket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await firstTransport.start(async () => {
      attempts += 1;
      throw new Error("simulated app handler failure");
    });
    if (!firstProcessEvents) {
      throw new Error("Expected first connection event processor to be registered");
    }
    await firstProcessEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ chatId, text: "retry me", senderId: "retry-user" }),
        ],
      },
    });
    await delay(25);
    await firstTransport.stop();

    assert.equal(attempts, 1);

    const secondSocket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          secondProcessEvents = handler;
        },
      },
      sendPresenceUpdate: async () => {},
    }));
    const secondTransport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(secondSocket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await secondTransport.start(async (turn) => {
      attempts += 1;
      deliveredTurns.push(turn);
    });
    if (!secondProcessEvents) {
      throw new Error("Expected second connection event processor to be registered");
    }
    await waitForTransportBackgroundWork();
    await delay(25);

    assert.equal(attempts, 2);
    assert.equal(deliveredTurns.length, 1);
    assert.deepEqual(
      deliveredTurns[0].content.filter((block) => block.type === "text").map((block) => block.text),
      ["retry me"],
    );
  });

  it("journals inbound messages while dispatch waits for startup recovery readiness", async () => {
    if (!testStore) {
      throw new Error("Expected test store to be initialized");
    }

    const chatId = `inbound-ready-gate-${Date.now()}@g.us`;
    /** @type {(() => void) | null} */
    let markReady = null;
    const dispatchReady = new Promise((resolve) => {
      markReady = () => resolve(undefined);
    });
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<ChatTurn>} */
    const deliveredTurns = [];

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendPresenceUpdate: async () => {},
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      inboundDispatchReady: dispatchReady,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await transport.start(async (turn) => {
      deliveredTurns.push(turn);
    });
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({ chatId, text: "wait until ready", senderId: "ready-user" }),
        ],
      },
    });
    await delay(25);

    assert.equal(deliveredTurns.length, 0);

    markReady?.();
    await delay(25);

    assert.equal(deliveredTurns.length, 1);
    assert.deepEqual(
      deliveredTurns[0].content.filter((block) => block.type === "text").map((block) => block.text),
      ["wait until ready"],
    );
  });

  it("replays queued outbound events when the connection opens again", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-transport-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection Closed");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    const queuedHandle = await transport.sendEvent?.(chatId, {
      kind: "assistant_output",
      content: "queued on disconnect",
    });

    assert.equal(queuedHandle?.deliveryStatus, "queued");
    assert.equal(typeof queuedHandle?.waitUntilSent, "function");
    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued on disconnect"),
    }]);
    const sentHandle = await queuedHandle?.waitUntilSent?.({ timeoutMs: 10 });
    assert.equal(sentHandle?.deliveryStatus, "sent");
    assert.equal(typeof sentHandle?.transportHandleId, "string");
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("retries queued outbound events after a recoverable send failure on an open socket", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-open-retry-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = false;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection Closed");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    failSends = true;
    const queuedHandle = await transport.sendEvent?.(chatId, {
      kind: "assistant_output",
      content: "queued after open failure",
    });

    assert.equal(queuedHandle?.deliveryStatus, "queued");
    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    await delay(150);
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued after open failure"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("retries queued text sends after a recoverable send failure on an open socket", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-open-text-retry-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = false;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection Closed");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    failSends = true;
    await transport.sendText(chatId, "queued text after open failure");

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    await delay(150);
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("queued text after open failure"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("applies queued handle updates to the sent message after reconnect", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-update-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection Closed");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    const queuedHandle = await transport.sendEvent?.(chatId, assistantOutputEvent("queued before edit"));
    assert.equal(queuedHandle?.deliveryStatus, "queued");

    const updatePromise = queuedHandle?.update(textUpdate("queued after edit"));

    failSends = false;
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await updatePromise;

    assert.deepEqual(sentMessages, [
      {
        chatId,
        message: makeTextMessage("🤖 queued before edit"),
      },
      {
        chatId,
        message: makeTextMessage("🤖 queued after edit", {
          edit: { id: "sent-1", remoteJid: chatId, fromMe: true },
        }),
      },
    ]);
  });

  it("queues outbound events after websocket abnormal closure send failures", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-1006-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("1006");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });

    await transport.sendEvent?.(chatId, {
      kind: "assistant_output",
      content: "queued after 1006",
    });

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued after 1006"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("queues runtime events after Baileys group metadata rate-limit send failures", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `queued-rate-overlimit-${Date.now()}@g.us`;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        throw createBaileysRateOverlimitError();
      },
    }));

    const handle = await sendOrQueueWhatsAppEvent({
      getSocket: () => socket,
      chatId,
      event: runtimeEvent({
        type: "turn.started",
        provider: "codex",
        turn: { status: "started" },
      }),
      store: testStore,
    });

    assert.equal(handle?.deliveryStatus, "queued");
    assert.equal(sentMessages.length, 1);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);
    assert.equal((await getDeadLetterRows(testDb, chatId)).length, 0);
    if (handle.queueId) {
      await testStore.deleteWhatsAppOutboundQueueEntry(chatId, handle.queueId);
    }
  });

  it("delays durable queue writes and retries if the socket recovers during the debounce window", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const previousDelay = process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
    process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = "30";
    try {
      const chatId = `debounced-queue-${Date.now()}`;
      /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
      const sentMessages = [];
      let liveSocket = /** @type {import("@whiskeysockets/baileys").WASocket | null} */ (null);
      const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
        sendMessage: async (targetChatId, message) => {
          sentMessages.push({ chatId: targetChatId, message });
          return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
        },
      }));

      const sendPromise = sendOrQueueWhatsAppEvent({
        getSocket: () => liveSocket,
        chatId,
        event: assistantOutputEvent("send after quick reconnect"),
        store: testStore,
      });

      assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
      liveSocket = socket;
      const handle = await sendPromise;

      assert.equal(handle?.deliveryStatus, "sent");
      assert.deepEqual(sentMessages, [{
        chatId,
        message: makeTextMessage("🤖 send after quick reconnect"),
      }]);
      assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS;
      } else {
        process.env.MADABOT_OUTBOUND_QUEUE_PERSIST_DELAY_MS = previousDelay;
      }
    }
  });

  it("preserves queued event send options during replay", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `queued-options-${Date.now()}`;
    const quoted = createWAMessage({ text: "original audio", senderId: "quote-user" });
    /** @type {Array<{ chatId: string, message: Record<string, unknown>, options?: Record<string, unknown> }>} */
    const sentMessages = [];
    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      sendMessage: async (targetChatId, message, options) => {
        sentMessages.push({ chatId: targetChatId, message, options });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const handle = await sendOrQueueWhatsAppEvent({
      getSocket: () => null,
      chatId,
      event: appMessageEvent("plain", "Transcribing audio...", { replyToTriggeringMessage: true }),
      options: { quoted },
      store: testStore,
    });

    assert.equal(handle?.deliveryStatus, "queued");
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    await flushQueuedWhatsAppOutbound({
      getSocket: () => socket,
      store: testStore,
    });

    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    assert.equal(sentMessages[0]?.message.text, "Transcribing audio...");
    assert.deepEqual(sentMessages[0]?.options?.quoted, quoted);
  });

  it("keeps queued outbound rows when the connection is lost during reconnect", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-group-metadata-${Date.now()}@g.us`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw new Error("Connection was lost");
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    await transport.sendEvent?.(chatId, assistantOutputEvent("queued during reconnect"));
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    failSends = false;
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued during reconnect"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("paces queued outbound replay between rows", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `paced-replay-${Date.now()}`;
    /** @type {number[]} */
    const waits = [];
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: { kind: "text", text: "first queued send" },
    });
    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: { kind: "text", text: "second queued send" },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    await flushQueuedWhatsAppOutbound({
      getSocket: () => socket,
      store: testStore,
      replayDelayMs: 250,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    assert.deepEqual(waits, [250]);
    assert.deepEqual(sentMessages, [
      { chatId, message: makeTextMessage("first queued send") },
      { chatId, message: makeTextMessage("second queued send") },
    ]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("keeps queued outbound rows when Baileys rate-limits group metadata during replay", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `queued-replay-rate-overlimit-${Date.now()}@g.us`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failSends = true;

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: assistantOutputEvent("queued while rate limited"),
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (failSends) {
          throw createBaileysRateOverlimitError();
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);
    assert.equal((await getDeadLetterRows(testDb, chatId)).length, 0);

    failSends = false;
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued while rate limited"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("quarantines row-specific replay failures without blocking later FIFO rows", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `quarantine-${Date.now()}@g.us`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let failMetadataRow = true;

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: assistantOutputEvent("old blocked answer"),
      },
    });
    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: agentToolResultEvent("Restart signal sent."),
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (message.text === "🤖 old blocked answer" && failMetadataRow) {
          failMetadataRow = false;
          throw createBaileysGroupMetadataAttrsError();
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("✅ Restart signal sent."),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    const deadLetters = await getDeadLetterRows(testDb, chatId);
    assert.equal(deadLetters.length, 1);
    assert.match(deadLetters[0].reason, /attrs/);
  });

  it("replays queued runtime events instead of treating them as malformed", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `runtime-replay-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: {
          kind: "runtime_event",
          event: {
            type: "turn.started",
            provider: "codex",
            turn: { status: "started" },
          },
        },
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();
    for (let attempt = 0; sentMessages.length < 2 && attempt < 50; attempt += 1) {
      await delay(10);
    }

    assert.deepEqual(sentMessages, [
      {
        chatId,
        message: makeTextMessage("🔄 *CODEX*  turn started"),
      },
      {
        chatId,
        message: {
          pin: { id: "sent-1", remoteJid: chatId, fromMe: true },
          type: 1,
          time: 86400,
        },
      },
    ]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    assert.equal((await getDeadLetterRows(testDb, chatId)).length, 0);
  });

  it("replays ACP tool notifications with expired edit handles as replacement messages", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `acp-expired-edit-replay-${Date.now()}@g.us`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    const expiredEditHandleStore = {
      ...testStore,
      getWhatsAppEditHandle: async (/** @type {string} */ id) => {
        const row = await testStore.getWhatsAppEditHandle(id);
        return row ? { ...row, expires_at: "2000-01-01T00:00:00.000Z" } : null;
      },
    };

    const tool = {
      id: "acp-tool-expired-edit",
      name: "Task",
      arguments: { title: "Review mock code" },
    };
    await expiredEditHandleStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: {
          kind: "runtime_event",
          event: {
            type: "tool.started",
            provider: "acp",
            tool,
          },
        },
      },
    });
    await expiredEditHandleStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: {
          kind: "runtime_event",
          event: {
            type: "tool.completed",
            provider: "acp",
            tool: {
              ...tool,
              output: "done",
            },
          },
        },
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId, fromMe: true } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      outboundStore: expiredEditHandleStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();
    for (let attempt = 0; sentMessages.length < 2 || (await getQueuedRows(testDb, chatId)).length > 0; attempt += 1) {
      if (attempt >= 50) {
        break;
      }
      await delay(10);
    }

    assert.deepEqual(sentMessages.filter((entry) => typeof entry.message.text === "string"), [
      {
        chatId,
        message: makeTextMessage("🔧 *Task*  Review mock code"),
      },
      {
        chatId,
        message: makeTextMessage("✅ *Task*  Review mock code"),
      },
    ]);
    assert.ok(sentMessages.some((entry) => entry.message.react?.text === "👁" && entry.message.react.key?.id === "sent-1"));
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
    assert.equal((await getDeadLetterRows(testDb, chatId)).length, 0);
  });

  it("runs connection-open hooks after queued outbound messages are flushed", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `restart-open-hook-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {string[]} */
    const hookObservations = [];
    /** @type {number | undefined} */
    let queuedAckId;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      onConnectionOpen: async ({ editMessage, recoverQueuedMessage, phase }) => {
        if (phase !== "afterQueueFlush") {
          return;
        }
        hookObservations.push(`sent:${sentMessages.length}`);
        if (!queuedAckId) {
          throw new Error("Expected queued handle id before connection open");
        }
        const recoveredHandle = recoverQueuedMessage({ chatId, queueId: queuedAckId });
        assert.equal(typeof recoveredHandle?.transportHandleId, "string");
        await editMessage({
          transportHandleId: recoveredHandle.transportHandleId,
          text: "Restarted.",
        });
      },
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async () => {});
    const queuedHandle = await transport.sendEvent?.(chatId, {
      kind: "assistant_output",
      content: "queued before open hook",
    });
    queuedAckId = queuedHandle?.queueId;

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookObservations, ["sent:1"]);
    assert.deepEqual(sentMessages, [
      {
        chatId,
        message: makeTextMessage("🤖 queued before open hook"),
      },
      {
        chatId,
        message: makeTextMessage("Restarted.", {
          edit: { id: "sent-1", remoteJid: chatId, fromMe: true },
        }),
      },
    ]);
  });

  it("runs connection-open hooks before initial-sync buffering drains", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `restart-open-before-buffer-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {string[]} */
    const hookPhases = [];
    let buffering = true;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
        isBuffering() {
          return buffering;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      onConnectionOpen: async ({ editMessage, phase }) => {
        hookPhases.push(phase);
        if (phase === "beforeQueueFlush") {
          await editMessage({
            transportHandleId: "existing-restart-handle",
            text: "Restarted.",
          });
        }
      },
      outboundStore: testStore,
    });

    await testStore.saveWhatsAppEditHandle({
      id: "existing-restart-handle",
      chatId,
      messageKeyJson: { id: "restart-signal-message", remoteJid: chatId, fromMe: true },
      messageKind: "text",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookPhases, ["beforeQueueFlush"]);
    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("Restarted.", {
        edit: { id: "restart-signal-message", remoteJid: chatId, fromMe: true },
      }),
    }]);

    buffering = false;
    await delay(150);
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookPhases, ["beforeQueueFlush", "afterQueueFlush"]);
  });

  it("runs connection-open hooks after queued outbound flushes complete", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `restart-open-hook-fifo-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {string[]} */
    const hookPhases = [];
    /** @type {() => void} */
    let releaseQueuedSend = () => {};
    const queuedSendWait = new Promise((resolve) => {
      releaseQueuedSend = () => resolve(undefined);
    });

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: assistantOutputEvent("queued unrelated output"),
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        if (message.text === "🤖 queued unrelated output") {
          await queuedSendWait;
        }
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      onConnectionOpen: async ({ phase }) => {
        hookPhases.push(phase);
      },
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }
    let openResolved = false;
    const openPromise = processEvents({
      "connection.update": {
        connection: "open",
      },
    }).then(() => {
      openResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(openResolved, true);
    assert.deepEqual(hookPhases, ["beforeQueueFlush"]);
    assert.deepEqual(sentMessages, []);

    releaseQueuedSend();
    await openPromise;
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookPhases, ["beforeQueueFlush", "afterQueueFlush"]);
    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued unrelated output"),
    }]);
  });

  it("waits for Baileys initial-sync buffering to drain before queued outbound replay", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const chatId = `restart-open-buffering-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {string[]} */
    const hookPhases = [];
    let buffering = true;

    await testStore.enqueueWhatsAppOutboundQueueEntry({
      chatId,
      payloadJson: {
        kind: "event",
        event: assistantOutputEvent("queued while initial sync is buffering"),
      },
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
        isBuffering() {
          return buffering;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    const transport = await createWhatsAppTransport({
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      onConnectionOpen: async ({ phase }) => {
        hookPhases.push(phase);
      },
      outboundStore: testStore,
    });

    await transport.start(async () => {});
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, []);
    assert.deepEqual(hookPhases, ["beforeQueueFlush"]);

    buffering = false;
    await delay(150);
    await waitForTransportBackgroundWork();

    assert.deepEqual(hookPhases, ["beforeQueueFlush", "afterQueueFlush"]);
    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued while initial sync is buffering"),
    }]);
  });

  it("edits the restart acknowledgement through a transport-owned durable handle", async () => {
    if (!testDb || !testStore) {
      throw new Error("Expected test DB and store to be initialized");
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), "restart-transport-"));
    const restartAckStore = createRestartAckStore(path.join(dir, "ack.json"));
    const chatId = `restart-e2e-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    let buffering = false;

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      ev: {
        process(handler) {
          processEvents = handler;
        },
        isBuffering() {
          return buffering;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
    }));

    try {
      const firstTransport = await createWhatsAppTransport({
        createConnectionSupervisor: async ({ onSocketReady }) => ({
          start: async () => {
            onSocketReady(socket, async () => {});
          },
          stop: async () => {},
          sendText: async () => {},
          handleConnectionUpdate: async () => {},
          isStopped: () => false,
        }),
        outboundStore: testStore,
      });

      await firstTransport.start(async () => {});
      if (!processEvents) {
        throw new Error("Expected connection event processor to be registered");
      }
      await processEvents({ "connection.update": { connection: "open" } });

      const restartingHandle = await firstTransport.sendEvent?.(
        chatId,
        assistantOutputEvent("Restarting..."),
      );
      assert.equal(typeof restartingHandle?.transportHandleId, "string");

      let scheduled = 0;
      const restartCommandHandler = createRestartCommandHandler({
        restartScheduler: () => {
          scheduled += 1;
        },
        restartAckStore,
        restartRuntime: {
          listActiveTurns: () => [],
          waitForIdle: async () => [],
        },
      });
      const result = await restartCommandHandler({
        chatId,
        senderIds: ["master-user"],
      }, {});

      await result.afterResponse?.({ handle: restartingHandle });
      assert.equal(scheduled, 1);

      const pendingAck = await restartAckStore.read();
      assert.equal(typeof pendingAck?.transportHandleId, "string");
      assert.ok(await testStore.getWhatsAppEditHandle(pendingAck.transportHandleId));

      const secondTransport = await createWhatsAppTransport({
        createConnectionSupervisor: async ({ onSocketReady }) => ({
          start: async () => {
            onSocketReady(socket, async () => {});
          },
          stop: async () => {},
          sendText: async () => {},
          handleConnectionUpdate: async () => {},
          isStopped: () => false,
        }),
        onConnectionOpen: async ({ editMessage, sendText, recoverQueuedMessage }) => {
          await deliverPendingRestartAck({
            store: restartAckStore,
            editMessage,
            sendText,
            recoverQueuedMessage,
          });
        },
        outboundStore: testStore,
      });

      processEvents = null;
      buffering = true;
      await secondTransport.start(async () => {});
      if (!processEvents) {
        throw new Error("Expected second connection event processor to be registered");
      }
      await processEvents({ "connection.update": { connection: "open" } });
      await waitForTransportBackgroundWork();

      assert.deepEqual(sentMessages, [
        {
          chatId,
          message: makeTextMessage("🤖 Restarting..."),
        },
        {
          chatId,
          message: makeTextMessage("Restarted.", {
            edit: { id: "sent-1", remoteJid: chatId, fromMe: true },
          }),
        },
      ]);

      buffering = false;
      await delay(150);
      await waitForTransportBackgroundWork();
      assert.equal(await restartAckStore.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queues turn replies while the socket exists but the connection is not open yet", async () => {
    if (!testDb) {
      throw new Error("Expected test DB to be initialized");
    }

    const chatId = `queued-before-open-${Date.now()}`;
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {() => void} */
    let resolveReplyHandled = () => {};
    const replyHandled = new Promise((resolve) => {
      resolveReplyHandled = resolve;
    });

    const socket = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid" },
      ev: {
        process(handler) {
          processEvents = handler;
        },
      },
      sendMessage: async (targetChatId, message) => {
        sentMessages.push({ chatId: targetChatId, message });
        return { key: { id: `sent-${sentMessages.length}`, remoteJid: targetChatId } };
      },
      sendPresenceUpdate: async () => {},
    }));

    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          onSocketReady(socket, async () => {});
        },
        stop: async () => {},
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => false,
      }),
      ...(testStore ? { outboundStore: testStore } : {}),
    });

    await transport.start(async (turn) => {
      try {
        await turn.io.reply(assistantOutputEvent("queued while opening"));
      } finally {
        resolveReplyHandled();
      }
    });

    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered");
    }

    await processEvents({
      "messages.upsert": {
        type: "notify",
        messages: [
          createWAMessage({
            text: "reply before open",
            senderId: "early-user",
            chatId,
          }),
        ],
      },
    });
    await replyHandled;

    assert.equal(sentMessages.length, 0);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 1);

    await processEvents({
      "connection.update": {
        connection: "open",
      },
    });
    await waitForTransportBackgroundWork();

    assert.deepEqual(sentMessages, [{
      chatId,
      message: makeTextMessage("🤖 queued while opening"),
    }]);
    assert.equal((await getQueuedRows(testDb, chatId)).length, 0);
  });

  it("returns the created community id from Baileys community metadata", async () => {
    const socket = {
      communityCreate: async () => ({
        id: "community-12345",
        subject: "Project Main",
      }),
    };

    const result = await executeCommunityCreate(socket, "Project Main", "Primary workspace community");

    assert.deepEqual(result, {
      chatId: "community-12345@g.us",
      subject: "Project Main",
    });
  });

  it("throws when Baileys communityCreate returns no community id", async () => {
    const socket = {
      communityCreate: async () => ({ subject: "Project Main" }),
    };

    await assert.rejects(
      () => executeCommunityCreate(socket, "Project Main", "Primary workspace community"),
      /Baileys communityCreate returned no community id\./,
    );
  });

  it("returns the created subgroup id from Baileys group metadata", async () => {
    const socket = {
      communityCreateGroup: async () => ({
        id: "group-12345",
        subject: "payments",
      }),
    };

    const result = await executeCommunityCreateGroup(
      socket,
      "payments",
      ["user@s.whatsapp.net"],
      "community-12345@g.us",
    );

    assert.deepEqual(result, {
      chatId: "group-12345@g.us",
      subject: "payments",
    });
  });

  it("throws when Baileys communityCreateGroup returns no group id", async () => {
    const socket = {
      communityCreateGroup: async () => ({ subject: "payments" }),
    };

    await assert.rejects(
      () => executeCommunityCreateGroup(
        socket,
        "payments",
        ["user@s.whatsapp.net"],
        "community-12345@g.us",
      ),
      /Baileys communityCreateGroup returned no group id\./,
    );
  });

  it("returns the linked parent from Baileys group metadata", async () => {
    const socket = {
      groupMetadata: async () => ({
        linkedParent: "community-12345",
      }),
    };

    const result = await executeGroupLinkedParentLookup(socket, "group-12345@g.us");

    assert.equal(result, "community-12345@g.us");
  });

  it("returns null when Baileys group metadata has no linked parent", async () => {
    const socket = {
      groupMetadata: async () => ({
        linkedParent: null,
      }),
    };

    const result = await executeGroupLinkedParentLookup(socket, "group-12345@g.us");

    assert.equal(result, null);
  });

  it("returns deduped participant ids from Baileys group metadata", async () => {
    const socket = {
      groupMetadata: async () => ({
        participants: [
          { id: "user@s.whatsapp.net" },
          { id: "teammate@s.whatsapp.net" },
          { id: "user@s.whatsapp.net" },
          { id: "" },
          {},
        ],
      }),
    };

    const result = await executeGroupParticipantLookup(socket, "group-12345@g.us");

    assert.deepEqual(result, [
      "user@s.whatsapp.net",
      "teammate@s.whatsapp.net",
    ]);
  });
});
