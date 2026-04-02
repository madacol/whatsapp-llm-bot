import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createChatTurn, createMockLlmServer, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);
  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;
  const { initStore } = await import("../store.js");
  store = await initStore(db);
});

after(async () => {
  await mockServer?.close();
});

/**
 * @param {string} chatId
 * @returns {Promise<void>}
 */
async function seedChat(chatId) {
  await seedChat_(db, chatId, { enabled: true });
}

/**
 * @param {{ transport?: ChatTransport }} [options]
 * @returns {Promise<(msg: ChatTurn) => Promise<void>>}
 */
async function createHandler(options = {}) {
  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();
  const { createMessageHandler } = await import("../index.js");
  const { getActions, executeAction } = await import("../actions.js");
  const handler = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
    transport: options.transport,
  });
  return handler.handleMessage;
}

describe("WhatsApp test command", () => {
  afterEach(() => {
    const pending = mockServer.pendingResponses();
    assert.equal(pending, 0, `Mock response queue should be empty after each test, but has ${pending} unconsumed response(s).`);
  });

  it("runs !test wa methods through the transport test port", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Logged methods to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-methods");

    const turn = createChatTurn({
      chatId: "wa-test-methods",
      content: [{ type: "text", text: "!test wa methods" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "methods",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Logged methods to /tmp/wh.log")));
  });

  it("runs !test wa smoke with the sender as participant", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Smoke test logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-smoke");

    const turn = createChatTurn({
      chatId: "wa-test-smoke",
      senderIds: ["user"],
      senderJids: ["user@s.whatsapp.net"],
      content: [{ type: "text", text: "!test wa smoke Payments Probe" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "smoke",
      baseSubject: "Payments Probe",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Smoke test logged to /tmp/wh.log")));
  });

  it("parses !test wa community-create with an inline description", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Community create logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-community-create");

    const turn = createChatTurn({
      chatId: "wa-test-community-create",
      content: [{ type: "text", text: "!test wa community-create Project Atlas: migration probe" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "community-create",
      subject: "Project Atlas",
      description: "migration probe",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Community create logged to /tmp/wh.log")));
  });

  it("parses !test wa community-create-group and falls back to senderId when jid is missing", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Community subgroup logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-create-group");

    const turn = createChatTurn({
      chatId: "wa-test-create-group",
      senderIds: ["fallback-user"],
      senderJids: [],
      content: [{ type: "text", text: "!test wa community-create-group 120363000000000000@g.us: main" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "community-create-group",
      parentCommunityJid: "120363000000000000@g.us",
      subject: "main",
      participants: ["fallback-user@s.whatsapp.net"],
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Community subgroup logged to /tmp/wh.log")));
  });

  it("parses !test wa community-link with two JIDs", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Community link logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-link");

    const turn = createChatTurn({
      chatId: "wa-test-link",
      content: [{ type: "text", text: "!test wa community-link 120363000000000000@g.us 120363999999999999@g.us" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "community-link",
      parentCommunityJid: "120363000000000000@g.us",
      groupJid: "120363999999999999@g.us",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Community link logged to /tmp/wh.log")));
  });

  it("shows usage when !test wa subcommand is missing", async () => {
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async () => {
          assert.fail("runWhatsAppTest should not be called for invalid syntax");
        },
      },
    });

    await seedChat("wa-test-usage");

    const turn = createChatTurn({
      chatId: "wa-test-usage",
      content: [{ type: "text", text: "!test wa" }],
    });
    await handleMessage(turn.context);

    assert.ok(turn.responses.some((response) => response.text.includes("Usage: `!test wa methods`")));
  });

  it("reports when the WhatsApp test port is unavailable", async () => {
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
      },
    });

    await seedChat("wa-test-unavailable");

    const turn = createChatTurn({
      chatId: "wa-test-unavailable",
      content: [{ type: "text", text: "!test wa methods" }],
    });
    await handleMessage(turn.context);

    assert.ok(turn.responses.some((response) => response.text.includes("unavailable in this runtime")));
  });
});
