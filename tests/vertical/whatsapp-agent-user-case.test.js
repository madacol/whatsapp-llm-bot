import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { updateChatConfig } from "../../chat-config.js";
import { setDb } from "../../db.js";
import { createMessageHandler } from "../../index.js";
import { initStore } from "../../store.js";
import { createWhatsAppTransport } from "../../whatsapp/create-whatsapp-transport.js";
import { registerAcpTestHarness, ZERO_USAGE } from "../acp-test-harness.js";
import { createTestDb, createWAMessage, seedChat } from "../helpers.js";

/** @typedef {Partial<import("@whiskeysockets/baileys").BaileysEventMap>} BaileysEvents */
/** @typedef {(events: BaileysEvents) => Promise<void>} BaileysEventHandler */

const originalTesting = process.env.TESTING;

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

/**
 * @returns {{
 *   socket: WhatsAppTransportSocketPort,
 *   processEvents: (events: BaileysEvents) => Promise<void>,
 *   sentMessages: Array<{ chatId: string, message: Record<string, unknown> }>,
 * }}
 */
function createFakeWhatsAppSocket() {
  /** @type {BaileysEventHandler | null} */
  let eventHandler = null;
  /** @type {Array<{ chatId: string, message: Record<string, unknown> }>} */
  const sentMessages = [];

  /** @type {WhatsAppTransportSocketPort} */
  const socket = {
    user: { id: "bot-phone-id:0@s.whatsapp.net", lid: "bot-lid-id:0@lid", name: "TestBot" },
    ev: {
      process(handler) {
        eventHandler = async (events) => {
          await handler(events);
        };
      },
    },
    sendMessage: async (chatId, message) => {
      if (!("react" in message)) {
        sentMessages.push({ chatId, message });
      }
      return { key: { id: `sent-${sentMessages.length}`, remoteJid: chatId, fromMe: true } };
    },
    sendPresenceUpdate: async () => {},
    signalRepository: {
      lidMapping: {
        getPNForLID: async () => null,
      },
    },
    groupMetadata: async () => ({ participants: [] }),
  };

  return {
    socket,
    sentMessages,
    async processEvents(events) {
      if (!eventHandler) {
        throw new Error("Expected WhatsApp transport to register an event processor.");
      }
      await eventHandler(events);
    },
  };
}

/**
 * @param {WhatsAppTransportSocketPort} socket
 * @returns {import("../../whatsapp/create-whatsapp-transport.js").WhatsAppConnectionSupervisorFactory}
 */
function useFakeConnectionSupervisor(socket) {
  return async ({ onSocketReady }) => ({
    start: async () => {
      onSocketReady(socket, async () => {});
    },
    stop: async () => {},
    sendText: async () => {},
    handleConnectionUpdate: async () => {},
    isStopped: () => false,
  });
}

describe("WhatsApp to agent user case", () => {
  /** @type {import("../../sqlite-db.js").SqliteDb} */
  let db;
  /** @type {import("../../store.js").Store} */
  let store;

  before(async () => {
    process.env.TESTING = "1";
    db = await createTestDb();
    setDb("./pgdata/root", db);
    store = await initStore(db);
  });

  after(() => {
    if (originalTesting === undefined) {
      delete process.env.TESTING;
    } else {
      process.env.TESTING = originalTesting;
    }
  });

  it("responds to a private WhatsApp text message through the selected agent harness", async () => {
    const harnessName = "vertical-user-case-agent";
    const senderId = "vertical-user-case";
    const chatId = `${senderId}@s.whatsapp.net`;
    const userText = "hello from whatsapp";
    const agentText = "hello from the fake agent";
    const harnessState = registerAcpTestHarness({
      name: harnessName,
      onSendTurn: (input) => ({
        response: [{ type: "markdown", text: agentText }],
        messages: input.messages ?? [],
        usage: ZERO_USAGE,
      }),
    });
    const { socket, processEvents, sentMessages } = createFakeWhatsAppSocket();
    const transport = await createWhatsAppTransport({
      outboundStore: store,
      inboundCoalesceDelayMs: 5,
      createConnectionSupervisor: useFakeConnectionSupervisor(socket),
    });
    const { handleMessage } = createMessageHandler({
      store,
      llmClient: /** @type {LlmClient} */ ({}),
      transport,
    });

    await seedChat(db, chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({ ...current, harness: harnessName }));
    try {
      await transport.start(handleMessage);
      await processEvents({ "connection.update": { connection: "open" } });
      await processEvents({
        "messages.upsert": {
          type: "notify",
          messages: [createWAMessage({ chatId, senderId, text: userText })],
        },
      });

      await waitForCondition(
        () => sentMessages.some((entry) =>
          entry.chatId === chatId
          && typeof entry.message.text === "string"
          && entry.message.text.includes(agentText)),
        `Expected WhatsApp response containing ${JSON.stringify(agentText)}, got ${JSON.stringify(sentMessages)}`,
      );

      assert.equal(harnessState.turns.length, 1);
      assert.equal(harnessState.turns[0]?.input, userText);
    } finally {
      await transport.stop();
    }
  });
});
