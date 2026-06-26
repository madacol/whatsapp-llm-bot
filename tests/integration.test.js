process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createChannelInput,
  createMockLlmServer,
  createTestDb,
  seedChat as seedChat_,
} from "./helpers.js";
import { createAcpTestHarnessState, registerAcpTestHarness } from "./acp-test-harness.js";
import { setDb } from "../db.js";
import config from "../config.js";
import { readChatConfig, updateChatConfig } from "../chat-config.js";

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChannelInput) => Promise<void>} */
let handleMessage;
/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;

const CACHE_PATH = path.resolve("data/models.json");
const HARNESS_NAME = "integration-acp";
const integrationHarnessState = createAcpTestHarnessState();
const capturedTurns = integrationHarnessState.turns;

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(testDb, chatId, options);

async function seedAcpChat(chatId, options = {}) {
  await registerIntegrationHarness();
  await seedChat(chatId, options);
  await updateChatConfig(chatId, (current) => ({
    ...current,
    harness: HARNESS_NAME,
  }));
}

async function registerIntegrationHarness() {
  registerAcpTestHarness({
    name: HARNESS_NAME,
    state: integrationHarnessState,
    errorMessage: "integration tests must use the semantic ACP adapter",
    onSendTurn: (input) => ({
      response: [{ type: "markdown", text: `ACP integration response: ${input.input ?? ""}` }],
      messages: input.messages ?? [],
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2, cost: 0.001 },
    }),
  });
}

describe("integration", { concurrency: 1 }, () => {
before(async () => {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify([
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
    { id: "mock-model", name: "Mock Model", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  ]));

  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  await registerIntegrationHarness();

  const { initStore } = await import("../store.js");
  const store = await initStore(testDb);
  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();
  const { createMessageHandler } = await import("../index.js");
  ({ handleMessage } = createMessageHandler({
    store,
    llmClient,
  }));
});

afterEach(() => {
  integrationHarnessState.reset();
  assert.equal(mockServer.pendingResponses(), 0);
});

after(async () => {
  await mockServer?.close();
  await fs.rm(CACHE_PATH, { force: true });
});

describe("createChannelInput shape", () => {
  it("includes react, select, and confirm in io", () => {
    const { context } = createChannelInput();
    assert.equal(typeof context.io.react, "function");
    assert.equal(typeof context.io.select, "function");
    assert.equal(typeof context.io.confirm, "function");
  });

  it("io helpers record responses", async () => {
    const { context, responses } = createChannelInput();
    await context.io.react("👍");
    assert.equal(await context.io.select("Vote", ["A", "B"]), "");
    assert.equal(await context.io.confirm("Are you sure?"), true);

    assert.ok(responses.some((response) => response.type === "reactToMessage" && response.text === "👍"));
    assert.ok(responses.some((response) => response.type === "select"));
    assert.ok(responses.some((response) => response.type === "confirm" && response.text === "Are you sure?"));
  });
});

describe("chat settings commands", () => {
  it("master user enables and disables a chat", async () => {
    await seedChat("settings-chat", { enabled: false });

    const enabled = createChannelInput({
      chatId: "settings-chat",
      content: [{ type: "text", text: "!s enabled on" }],
    });
    await handleMessage(enabled.context);
    assert.ok(enabled.responses.some((response) => response.text.toLowerCase().includes("enabled")));

    const disabled = createChannelInput({
      chatId: "settings-chat",
      content: [{ type: "text", text: "!s enabled off" }],
    });
    await handleMessage(disabled.context);

    const chat = await readChatConfig("settings-chat");
    assert.equal(chat?.is_enabled, false);
  });

  it("rejects enabled changes from non-master users", async () => {
    await seedChat("non-master-chat", { enabled: false });

    const { context, responses } = createChannelInput({
      chatId: "non-master-chat",
      senderIds: ["not-master"],
      content: [{ type: "text", text: "!s enabled on" }],
    });
    await handleMessage(context);

    assert.ok(responses.some((response) => response.text.toLowerCase().includes("master")));
    const chat = await readChatConfig("non-master-chat");
    assert.equal(chat?.is_enabled, false);
  });

  it("responds with error for unknown commands", async () => {
    await seedChat("unknown-command-chat", { enabled: true });

    const { context, responses } = createChannelInput({
      chatId: "unknown-command-chat",
      content: [{ type: "text", text: "!doesnotexist" }],
    });
    await handleMessage(context);

    assert.ok(responses.some((response) => response.source === "error" && response.text.includes("Unknown command")));
  });
});

describe("ACP conversation routing", () => {
  it("responds to enabled private chat through ACP", async () => {
    await seedAcpChat("private-acp-chat", { enabled: true });

    const { context, responses } = createChannelInput({
      chatId: "private-acp-chat",
      content: [{ type: "text", text: "hello ACP" }],
    });
    await handleMessage(context);

    assert.equal(capturedTurns[0].input, "hello ACP");
    assert.ok(responses.some((response) => response.text.includes("ACP integration response: hello ACP")));
  });

  it("does not respond in group when not mentioned", async () => {
    await seedAcpChat("group-ignore@g.us", { enabled: true });

    const { context, responses } = createChannelInput({
      chatId: "group-ignore@g.us",
      facts: { isGroup: true, addressedToBot: false, repliedToBot: false },
      content: [{ type: "text", text: "background chatter" }],
    });
    await handleMessage(context);

    assert.equal(capturedTurns.length, 0);
    assert.equal(responses.filter((response) => response.type === "reply").length, 0);
  });

  it("responds in group when addressed to bot", async () => {
    await seedAcpChat("group-mention@g.us", { enabled: true });

    const { context, responses } = createChannelInput({
      chatId: "group-mention@g.us",
      facts: { isGroup: true, addressedToBot: true },
      senderName: "Alice",
      content: [{ type: "text", text: "help with deploy" }],
    });
    await handleMessage(context);

    assert.equal(capturedTurns[0].input, "help with deploy");
    assert.ok(JSON.stringify(capturedTurns[0].messages).includes('"senderName":"Alice"'));
    assert.ok(responses.some((response) => response.text.includes("help with deploy")));
  });

  it("clear command removes prior messages before the next ACP turn", async () => {
    await seedAcpChat("clear-acp-chat", { enabled: true });

    await handleMessage(createChannelInput({
      chatId: "clear-acp-chat",
      content: [{ type: "text", text: "Remember ALPHA" }],
    }).context);
    await handleMessage(createChannelInput({
      chatId: "clear-acp-chat",
      content: [{ type: "text", text: "!clear" }],
    }).context);
    await handleMessage(createChannelInput({
      chatId: "clear-acp-chat",
      content: [{ type: "text", text: "What remains?" }],
    }).context);

    const lastTurn = capturedTurns.at(-1);
    assert.ok(lastTurn);
    const serialized = JSON.stringify(lastTurn.messages);
    assert.ok(!serialized.includes("ALPHA"), serialized);
    assert.ok(serialized.includes("What remains?"), serialized);
  });

  it("formats quoted text into ACP message context", async () => {
    await seedAcpChat("quote-acp-chat", { enabled: true });

    await handleMessage(createChannelInput({
      chatId: "quote-acp-chat",
      content: [
        { type: "quote", content: [{ type: "text", text: "Original quoted message" }] },
        { type: "text", text: "What about this?" },
      ],
    }).context);

    assert.ok(JSON.stringify(capturedTurns[0].messages).includes("Original quoted message"));
  });
});

describe("media conversion before ACP", () => {
  /** @type {string} */
  let savedVideoModel;
  /** @type {string} */
  let savedMediaModel;

  before(() => {
    savedVideoModel = config.video_to_text_model;
    savedMediaModel = config.media_to_text_model;
    config.video_to_text_model = "";
    config.media_to_text_model = "";
  });

  after(() => {
    config.video_to_text_model = savedVideoModel;
    config.media_to_text_model = savedMediaModel;
  });

  it("preserves video requests as ACP input text", async () => {
    await seedAcpChat("unsupported-video-chat", { enabled: true });

    const { context, responses } = createChannelInput({
      chatId: "unsupported-video-chat",
      content: [
        { type: "video", mime_type: "video/mp4", data: "AAAA", encoding: "base64" },
        { type: "text", text: "Check this video" },
      ],
    });
    await handleMessage(context);

    assert.ok(capturedTurns[0].input?.includes("Check this video"), capturedTurns[0].input);
    assert.ok(responses.some((response) => response.text.includes("ACP integration response")));
  });
});

});
