import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpRuntimeModel } from "../harnesses/acp-events.js";
import { createHarnessRuntimeEventDispatcher } from "../harnesses/harness-runtime-event-dispatcher.js";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";
import { sendEvent } from "../whatsapp/outbound/send-content.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { createWhatsAppTransport } from "../whatsapp/create-whatsapp-transport.js";
import { setDb } from "../db.js";
import { createTestDb } from "./helpers.js";

process.env.TESTING = "1";

const FIXTURE_ROOT = path.resolve("tests", "fixtures");

/**
 * @typedef {{
 *   chatId: string,
 *   message: Record<string, unknown>,
 *   id?: string,
 * }} ObservedBaileysMessage
 */

/**
 * @typedef {{
 *   sent?: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   sentMessages?: Array<{ chatId: string, message: Record<string, unknown>, id?: string }>,
 * }} VerticalSliceResult
 */

/**
 * @param {string} fixture
 * @returns {Promise<unknown>}
 */
async function readJsonFixture(fixture) {
  const fixturePath = path.join(FIXTURE_ROOT, fixture);
  const text = await fs.readFile(fixturePath, "utf8");
  return JSON.parse(text);
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

/**
 * @returns {{
 *   sock: {
 *     sendMessage: (chatId: string, msg: Record<string, unknown>) => Promise<{ key: { id: string, remoteJid: string, fromMe: true } }>,
 *     relayMessage: (chatId: string, msg: Record<string, unknown>, opts: Record<string, unknown>) => Promise<void>,
 *     waUploadToServer: () => Promise<{ mediaUrl: string, directPath: string }>,
 *     user: { id: string },
 *   },
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 * }}
 */
function createMockBaileysSocket() {
  /** @type {Array<{ chatId: string, msg: Record<string, unknown> }>} */
  const sent = [];
  return {
    sent,
    sock: {
      sendMessage: async (chatId, msg) => {
        sent.push({ chatId, msg });
        return { key: { id: `msg-${sent.length}`, remoteJid: chatId, fromMe: true } };
      },
      relayMessage: async () => {},
      waUploadToServer: async () => ({
        mediaUrl: "https://example.test/media",
        directPath: "/direct/path",
      }),
      user: { id: "test-user@s.whatsapp.net" },
    },
  };
}

/**
 * @param {VerticalSliceResult} result
 * @returns {ObservedBaileysMessage[]}
 */
function getObservedMessages(result) {
  if (Array.isArray(result.sent)) {
    return result.sent.map((entry) => ({
      chatId: entry.chatId,
      message: entry.msg,
    }));
  }
  if (Array.isArray(result.sentMessages)) {
    return result.sentMessages.map((entry) => ({
      chatId: entry.chatId,
      message: entry.message,
      ...(entry.id ? { id: entry.id } : {}),
    }));
  }
  return [];
}

/**
 * @param {{
 *   fixture: string,
 *   pipeline: (payload: unknown) => Promise<VerticalSliceResult>,
 *   expect: Array<(result: VerticalSliceResult) => void | Promise<void>>,
 * }} scenario
 * @returns {Promise<VerticalSliceResult>}
 */
export async function replayFixture(scenario) {
  const payload = await readJsonFixture(scenario.fixture);
  const result = await scenario.pipeline(payload);
  for (const assertion of scenario.expect) {
    await assertion(result);
  }
  return result;
}

/**
 * @param {string} expected
 * @returns {(actual: string) => void}
 */
export function textEquals(expected) {
  return (actual) => {
    assert.equal(actual, expected);
  };
}

/**
 * @param {string} expected
 * @returns {(actual: string) => void}
 */
export function textIncludes(expected) {
  return (actual) => {
    assert.ok(actual.includes(expected), `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  };
}

/**
 * @param {number} index
 * @param {{ text?: (actual: string) => void }} expected
 * @returns {(result: VerticalSliceResult) => void}
 */
export function expectSentMessage(index, expected) {
  return (result) => {
    const messages = getObservedMessages(result);
    const entry = messages[index];
    assert.ok(entry, `Expected sent message at index ${index}, got ${JSON.stringify(messages)}`);
    if (expected.text) {
      expected.text(String(entry.message.text ?? ""));
    }
  };
}

/**
 * @param {{ chatId?: string, cwd?: string }} [options]
 * @returns {(payload: unknown) => Promise<{
 *   sent: Array<{ chatId: string, msg: Record<string, unknown> }>,
 *   runtimeEvents: Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>,
 * }>}
 */
export function acpSessionUpdatesToBaileys(options = {}) {
  return async (payload) => {
    const chatId = options.chatId ?? "vertical-acp@s.whatsapp.net";
    const cwd = options.cwd ?? "/home/mada/whatsapp-llm-bot";
    const payloads = Array.isArray(payload) ? payload : [payload];
    const { sock, sent } = createMockBaileysSocket();
    /** @type {Array<import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent>} */
    const runtimeEvents = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => sendEvent(sock, chatId, event, undefined, undefined, {
          outputVisibility: DEFAULT_OUTPUT_VISIBILITY,
        }),
        reply: async (event) => sendEvent(sock, chatId, event, undefined, undefined, {
          outputVisibility: DEFAULT_OUTPUT_VISIBILITY,
        }),
        select: async () => "",
        confirm: async () => true,
      },
      cwd,
      DEFAULT_OUTPUT_VISIBILITY,
    );
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks,
      workdir: cwd,
    });
    const model = createAcpRuntimeModel();

    for (const entry of payloads) {
      assert.ok(entry && typeof entry === "object", `Expected ACP payload object, got ${JSON.stringify(entry)}`);
      const events = model.acceptSessionUpdate(/** @type {Record<string, unknown>} */ (entry));
      runtimeEvents.push(...events);
      for (const event of events) {
        await dispatcher.handleEvent(event);
      }
    }

    return { sent, runtimeEvents };
  };
}

/**
 * @param {{
 *   handleTurn: (turn: ChannelInput) => Promise<void>,
 *   inboundCoalesceDelayMs?: number,
 * }} options
 * @returns {(payload: unknown) => Promise<{
 *   sentMessages: Array<{ id: string, chatId: string, message: Record<string, unknown> }>,
 *   turns: ChannelInput[],
 * }>}
 */
export function whatsappInboundToBaileys(options) {
  return async (payload) => {
    const db = await createTestDb();
    setDb("./pgdata/root", db);
    const events = Array.isArray(payload) ? payload : [payload];
    /** @type {((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => Promise<void>) | null} */
    let processEvents = null;
    /** @type {Array<{ id: string, chatId: string, message: Record<string, unknown> }>} */
    const sentMessages = [];
    /** @type {ChannelInput[]} */
    const turns = [];
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
        return { key: { id, remoteJid: targetChatId, fromMe: true } };
      },
      sendPresenceUpdate: async () => {},
    }));
    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: options.inboundCoalesceDelayMs ?? 5,
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
      await options.handleTurn(turn);
    });

    try {
      if (!processEvents) {
        throw new Error("Expected connection event processor to be registered");
      }
      await processEvents({ "connection.update": { connection: "open" } });
      for (const event of events) {
        assert.ok(event && typeof event === "object", `Expected WhatsApp event object, got ${JSON.stringify(event)}`);
        await processEvents(/** @type {Partial<import("@whiskeysockets/baileys").BaileysEventMap>} */ (event));
      }
      await waitForCondition(
        () => sentMessages.length > 0,
        `Expected inbound fixture to produce a Baileys send, got turns=${turns.length}`,
      );
      return { sentMessages, turns };
    } finally {
      await transport.stop();
    }
  };
}
