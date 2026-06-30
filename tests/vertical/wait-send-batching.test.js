process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { updateChatConfig } from "../../chat-config.js";
import { setDb } from "../../db.js";
import { createMessageHandler } from "../../index.js";
import { initStore } from "../../store.js";
import { createConfirmRuntime } from "../../whatsapp/runtime/confirm-runtime.js";
import { createSelectRuntime } from "../../whatsapp/runtime/select-runtime.js";
import { adaptIncomingMessage } from "../../whatsapp/inbound/channel-input.js";
import { registerAcpTestHarness, ZERO_USAGE } from "../acp-test-harness.js";
import { createMockBaileysSocket, createTestDb, createWAMessage, seedChat } from "../helpers.js";
import { waitForCondition } from "./whatsapp-transport-testbed.js";

const originalTesting = process.env.TESTING;
const originalMasterId = process.env.MASTER_ID;

/**
 * @param {{
 *   chatId: string,
 *   harnessName: string,
 *   onSendTurn?: Parameters<typeof registerAcpTestHarness>[0]["onSendTurn"],
 * }} input
 * @returns {Promise<{
 *   handleMessage: (turn: ChannelInput) => Promise<void>,
 *   socket: ReturnType<typeof createMockBaileysSocket>,
 *   harnessState: ReturnType<typeof registerAcpTestHarness>,
 * }>}
 */
async function createWaitSendVertical({ chatId, harnessName, onSendTurn }) {
  const db = await createTestDb();
  setDb("./pgdata/root", db);
  const store = await initStore(db);
  const harnessState = registerAcpTestHarness({
    name: harnessName,
    onSendTurn: onSendTurn ?? ((input) => ({
      response: [{ type: "markdown", text: `batched: ${input.input ?? ""}` }],
      messages: input.messages ?? [],
      usage: ZERO_USAGE,
    })),
  });
  const { handleMessage } = createMessageHandler({
    store,
    llmClient: /** @type {LlmClient} */ ({}),
  });
  await seedChat(db, chatId, { enabled: true });
  await updateChatConfig(chatId, (current) => ({ ...current, harness: harnessName }));

  return {
    handleMessage,
    socket: createMockBaileysSocket(),
    harnessState,
  };
}

/**
 * @param {{
 *   handleMessage: (turn: ChannelInput) => Promise<void>,
 *   socket: ReturnType<typeof createMockBaileysSocket>,
 *   message: import("@whiskeysockets/baileys").WAMessage,
 *   mediaBytes?: Buffer,
 * }} input
 * @returns {Promise<void>}
 */
async function sendWhatsAppMessage({ handleMessage, socket, message, mediaBytes }) {
  await adaptIncomingMessage(
    message,
    socket.sock,
    handleMessage,
    createConfirmRuntime(),
    createSelectRuntime(),
    undefined,
    async () => mediaBytes ?? Buffer.from("vertical media bytes"),
    { outboundStore: undefined },
  );
}

after(() => {
  if (originalTesting === undefined) delete process.env.TESTING;
  else process.env.TESTING = originalTesting;
  if (originalMasterId === undefined) delete process.env.MASTER_ID;
  else process.env.MASTER_ID = originalMasterId;
});

describe("Wait/send batching vertical user case", () => {
  it("holds user-authored text until /send commits one agent turn", async () => {
    const chatId = "wait-send-text-user@s.whatsapp.net";
    const { handleMessage, socket, harnessState } = await createWaitSendVertical({
      chatId,
      harnessName: "wait-send-text-harness",
    });

    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-text-user", text: "/wait ignored control text" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-text-user", text: "first line" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-text-user", text: "second line" }),
    });

    assert.equal(harnessState.turns.length, 0);
    assert.ok(
      socket.getTextMessages().some((text) => text.includes("Batch started")),
      `Expected /wait acknowledgement, got ${JSON.stringify(socket.getTextMessages())}`,
    );

    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-text-user", text: "/send ignored control text" }),
    });

    assert.equal(harnessState.turns.length, 1);
    assert.equal(harnessState.turns[0]?.input, "first line\nsecond line");
    assert.ok(
      socket.getTextMessages().some((text) => text.includes("batched: first line")),
      `Expected agent response after /send, got ${JSON.stringify(socket.getTextMessages())}`,
    );
  });

  it("keeps media from batched WhatsApp messages and isolates batches per chat", async () => {
    const primaryChatId = "wait-send-media-user@s.whatsapp.net";
    const otherChatId = "wait-send-other-user@s.whatsapp.net";
    const primary = await createWaitSendVertical({
      chatId: primaryChatId,
      harnessName: "wait-send-media-harness",
    });
    const other = await createWaitSendVertical({
      chatId: otherChatId,
      harnessName: "wait-send-other-harness",
    });

    await sendWhatsAppMessage({
      handleMessage: primary.handleMessage,
      socket: primary.socket,
      message: createWAMessage({ chatId: primaryChatId, senderId: "wait-send-media-user", text: "/wait" }),
    });
    await sendWhatsAppMessage({
      handleMessage: primary.handleMessage,
      socket: primary.socket,
      message: createWAMessage({
        chatId: primaryChatId,
        senderId: "wait-send-media-user",
        image: { mimetype: "image/png", caption: "screenshot caption" },
      }),
      mediaBytes: Buffer.from("fake screenshot bytes"),
    });
    await sendWhatsAppMessage({
      handleMessage: other.handleMessage,
      socket: other.socket,
      message: createWAMessage({ chatId: otherChatId, senderId: "wait-send-other-user", text: "hello other chat" }),
    });

    assert.equal(primary.harnessState.turns.length, 0);
    assert.equal(other.harnessState.turns.length, 1);
    assert.equal(other.harnessState.turns[0]?.input, "hello other chat");

    await sendWhatsAppMessage({
      handleMessage: primary.handleMessage,
      socket: primary.socket,
      message: createWAMessage({ chatId: primaryChatId, senderId: "wait-send-media-user", text: "/send ignored control text" }),
    });

    assert.equal(primary.harnessState.turns.length, 1);
    const turn = primary.harnessState.turns[0];
    assert.ok(turn?.input?.includes("screenshot caption"), turn?.input);
    assert.equal(turn?.input?.includes("ignored control text"), false, turn?.input);
    assert.equal(turn?.messages?.at(-1)?.role, "user");
    const latestContent = turn?.messages?.at(-1)?.content ?? [];
    assert.deepEqual(
      latestContent.map((block) => block.type),
      ["image", "text"],
    );
  });

  it("does not batch non-agent command messages while a batch is open", async () => {
    const chatId = "wait-send-command-user@s.whatsapp.net";
    const { handleMessage, socket, harnessState } = await createWaitSendVertical({
      chatId,
      harnessName: "wait-send-command-harness",
    });

    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-command-user", text: "/wait" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-command-user", text: "!c" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-command-user", text: "real batched message" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-command-user", text: "/send" }),
    });

    assert.equal(harnessState.turns.length, 1);
    assert.equal(harnessState.turns[0]?.input, "real batched message");
    assert.ok(
      socket.getTextMessages().some((text) => text.includes("Nothing to cancel.")),
      `Expected !c to run as a command, got ${JSON.stringify(socket.getTextMessages())}`,
    );
  });

  it("/send with no pending batch is app-owned and does not invoke the agent", async () => {
    const chatId = "wait-send-empty-user@s.whatsapp.net";
    const { handleMessage, socket, harnessState } = await createWaitSendVertical({
      chatId,
      harnessName: "wait-send-empty-harness",
    });

    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-empty-user", text: "/send" }),
    });

    assert.equal(harnessState.turns.length, 0);
    assert.ok(
      socket.getTextMessages().some((text) => text.includes("No pending batch")),
      `Expected no-batch response, got ${JSON.stringify(socket.getTextMessages())}`,
    );
  });

  it("buffers a committed batch behind an active agent run instead of dropping it", async () => {
    const chatId = "wait-send-active-run-user@s.whatsapp.net";
    /** @type {() => void} */
    let releaseFirstRun = () => {};
    const firstRunGate = new Promise((resolve) => {
      releaseFirstRun = () => resolve(undefined);
    });
    const { handleMessage, socket, harnessState } = await createWaitSendVertical({
      chatId,
      harnessName: "wait-send-active-run-harness",
      onSendTurn: async (input) => {
        if (input.input === "long first turn") {
          await firstRunGate;
        }
        return {
          response: [{ type: "markdown", text: `active: ${input.input ?? ""}` }],
          messages: input.messages ?? [],
          usage: ZERO_USAGE,
        };
      },
    });

    const activeRun = sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-active-run-user", text: "long first turn" }),
    });
    await waitForCondition(() => harnessState.turns.length === 1, "Expected first active turn to start.");

    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-active-run-user", text: "/wait ignored control text" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-active-run-user", text: "queued one" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-active-run-user", text: "queued two" }),
    });
    await sendWhatsAppMessage({
      handleMessage,
      socket,
      message: createWAMessage({ chatId, senderId: "wait-send-active-run-user", text: "/send ignored control text" }),
    });

    assert.equal(harnessState.turns.length, 1);
    releaseFirstRun();
    await activeRun;

    assert.equal(harnessState.turns.length, 2);
    assert.equal(harnessState.turns[1]?.input, "queued one\nqueued two");
  });
});
