import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createChatTurn, createMockLlmServer, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { createAcpTestHarnessState, registerAcpTestHarness } from "./acp-test-harness.js";
import { setDb } from "../db.js";
import { updateChatConfig } from "../chat-config.js";

/** @type {import("../sqlite-db.js").SqliteDb} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;

const HARNESS_NAME = "pipeline-acp";
const pipelineHarnessState = createAcpTestHarnessState();
const capturedTurns = pipelineHarnessState.turns;

async function registerPipelineHarness() {
  registerAcpTestHarness({
    name: HARNESS_NAME,
    state: pipelineHarnessState,
    errorMessage: "pipeline tests must use the semantic ACP adapter",
    onSendTurn: (input) => {
      if (input.input?.includes("Trigger provider error")) {
        throw new Error("Provider failed intentionally");
      }
      return {
        response: [{ type: "markdown", text: `ACP response: ${input.input ?? ""}` }],
        messages: input.messages ?? [],
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 8, cost: 0.001 },
      };
    },
  });
}

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  await registerPipelineHarness();

  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();

  const { createMessageHandler } = await import("../index.js");

  ({ handleMessage } = createMessageHandler({
    store,
    llmClient,
  }));
});

after(async () => {
  await mockServer?.close();
});

afterEach(() => {
  pipelineHarnessState.reset();
  assert.equal(mockServer.pendingResponses(), 0);
});

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
async function seedAcpChat(chatId, options = {}) {
  await registerPipelineHarness();
  await seedChat_(db, chatId, options);
  await updateChatConfig(chatId, (current) => ({
    ...current,
    harness: HARNESS_NAME,
  }));
}

/**
 * @param {Message[]} messages
 * @returns {string}
 */
function getLastUserText(messages) {
  const lastMessage = messages.at(-1);
  assert.ok(lastMessage, "Expected a final message");
  assert.equal(lastMessage.role, "user");
  const textBlock = lastMessage.content.find((block) => block.type === "text");
  assert.ok(textBlock, "Expected the last user message to include text");
  return textBlock.text;
}

describe("ACP pipeline via createMessageHandler", () => {
  it("stores a message, sends ACP turn input, and delivers provider response", async () => {
    await seedAcpChat("pipe-1", { enabled: true });

    const { context, responses } = createChatTurn({
      chatId: "pipe-1",
      content: [{ type: "text", text: "Test message" }],
    });
    await handleMessage(context);

    assert.equal(capturedTurns.length, 1);
    assert.equal(capturedTurns[0].input, "Test message");
    assert.ok(responses.some((response) => response.text.includes("ACP response: Test message")));
  });

  it("allows freeform ACP work in project chats", async () => {
    await seedAcpChat("pipe-repo-chat", { enabled: true });
    await store.createProject({
      name: "pipe-repo",
      rootPath: "/repo/main",
      defaultBaseBranch: "master",
      controlChatId: "pipe-repo-chat",
    });

    const { context, responses } = createChatTurn({
      chatId: "pipe-repo-chat",
      content: [{ type: "text", text: "implement retry logic" }],
    });
    await handleMessage(context);

    assert.ok(responses.some((response) => response.text.includes("implement retry logic")));
    assert.equal(capturedTurns[0].runConfig?.workdir, "/repo/main");
  });

  it("passes explicit chat prompt as ACP external instructions", async () => {
    await seedAcpChat("pipe-prompt", { enabled: true, systemPrompt: "You are a pirate" });

    const { context } = createChatTurn({
      chatId: "pipe-prompt",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    assert.equal(capturedTurns[0].externalInstructions, "You are a pirate");
  });

  it("sends unknown slash commands through the ACP turn path", async () => {
    await seedAcpChat("pipe-slash-unknown", { enabled: true });

    const { context, responses } = createChatTurn({
      chatId: "pipe-slash-unknown",
      content: [{ type: "text", text: "/status" }],
    });
    await handleMessage(context);

    assert.ok(responses.some((response) => response.text.includes("ACP response: /status")));
    assert.equal(getLastUserText(capturedTurns[0].messages ?? []), "/status");
  });

  it("clear then continue: ACP only sees post-clear messages", async () => {
    await seedAcpChat("pipe-clear-cont", { enabled: true });

    await handleMessage(createChatTurn({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "Remember this secret: ALPHA" }],
    }).context);
    await store.saveHarnessSession("pipe-clear-cont", { id: "stale-session", kind: "codex" });
    await handleMessage(createChatTurn({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "!clear" }],
    }).context);
    assert.deepEqual(pipelineHarnessState.stoppedSessions, ["pipe-clear-cont"]);
    await handleMessage(createChatTurn({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "What do you know?" }],
    }).context);

    const lastTurn = capturedTurns.at(-1);
    assert.ok(lastTurn);
    assert.equal(lastTurn.resumeCursor, null);
    const allContent = JSON.stringify(lastTurn.messages);
    assert.ok(!allContent.includes("ALPHA"), allContent);
    assert.ok(allContent.includes("What do you know?"), allContent);
    assert.equal((await store.getChat("pipe-clear-cont"))?.harness_session_id, null);
  });

  it("passes historical messages to ACP in chronological order", async () => {
    await seedAcpChat("pipe-order", { enabled: true });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"first msg"}]}', ${threeHoursAgo})`;
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"second msg"}]}', ${twoHoursAgo})`;
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"third msg"}]}', ${oneHourAgo})`;

    await handleMessage(createChatTurn({
      chatId: "pipe-order",
      content: [{ type: "text", text: "fourth msg" }],
    }).context);

    const allText = JSON.stringify(capturedTurns[0].messages);
    const pos1 = allText.indexOf("first msg");
    const pos2 = allText.indexOf("second msg");
    const pos3 = allText.indexOf("third msg");
    const pos4 = allText.indexOf("fourth msg");
    assert.ok(pos1 >= 0 && pos4 >= 0, allText);
    assert.ok(pos1 < pos2, allText);
    assert.ok(pos2 < pos3, allText);
    assert.ok(pos3 < pos4, allText);
  });

  it("leaves WhatsApp presence out of the conversation pipeline for ACP responses", async () => {
    await seedAcpChat("pipe-presence", { enabled: true });

    const { context, responses } = createChatTurn({
      chatId: "pipe-presence",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    assert.ok(responses.some((response) => response.text.includes("ACP response")));
    assert.equal(responses.filter((response) => response.type === "sendPresenceUpdate").length, 0);
  });

  it("leaves WhatsApp presence out of the conversation pipeline when ACP providers error", async () => {
    await seedAcpChat("pipe-presence-err", { enabled: true });

    const { context, responses } = createChatTurn({
      chatId: "pipe-presence-err",
      content: [{ type: "text", text: "Trigger provider error" }],
    });
    await handleMessage(context);

    const presenceUpdates = responses.filter((response) => response.type === "sendPresenceUpdate");
    assert.equal(presenceUpdates.length, 0);
    assert.ok(responses.some((response) => response.source === "error"));
  });

  it("does not send composing when bot decides not to respond", async () => {
    await seedAcpChat("pipe-presence-skip", { enabled: false });

    const { context, responses } = createChatTurn({
      chatId: "pipe-presence-skip",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    assert.equal(capturedTurns.length, 0);
    assert.equal(responses.filter((response) => response.type === "sendPresenceUpdate").length, 0);
  });
});
