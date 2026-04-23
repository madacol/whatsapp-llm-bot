process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createMockLlmServer,
  createMockBaileysSocket,
  createWAMessage,
  createTestDb,
  seedChat,
} from "./helpers.js";
import { setDb } from "../db.js";
import { adaptIncomingMessage } from "../whatsapp/inbound/chat-turn.js";
import { createConfirmRuntime } from "../whatsapp/runtime/confirm-runtime.js";
import { createSelectRuntime } from "../whatsapp/runtime/select-runtime.js";

const testConfirmRegistry = createConfirmRuntime();
const testUserResponseRegistry = createSelectRuntime();

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;
/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;

const CACHE_PATH = path.resolve("data/models.json");

// ── Full e2e: WAMessage → adapter → handleMessage → mock LLM → socket output ──

describe("e2e adapter", { concurrency: 1 }, () => {

before(async () => {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify([
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  ]));

  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  const { initStore } = await import("../store.js");
  const store = await initStore(testDb);
  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();
  const { createMessageHandler } = await import("../index.js");
  const { getActions, executeAction } = await import("../actions.js");
  ({ handleMessage } = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
  }));
});

after(async () => {
  await mockServer?.close();
  await fs.rm(CACHE_PATH, { force: true });
});

// ═══════════════════════════════════════════════════════════════════
// 1. Basic text message through the full pipeline
// ═══════════════════════════════════════════════════════════════════
describe("basic text message", () => {
  // senderId "e2e-user" → chatId "e2e-user@s.whatsapp.net"
  const senderId = "e2e-user";
  const chatId = `${senderId}@s.whatsapp.net`;

  before(async () => {
    await seedChat(testDb, chatId, { enabled: true });
  });

  it("sends a WAMessage through adapter → handleMessage → LLM → socket response", async () => {
    mockServer.addResponses("Hello from LLM!");

    const { sock, getTextMessages } = createMockBaileysSocket();
    const msg = createWAMessage({ text: "Hey there", senderId });

    await adaptIncomingMessage(msg, sock, handleMessage, testConfirmRegistry, testUserResponseRegistry);

    const texts = getTextMessages();
    assert.ok(
      texts.some(t => t.includes("Hello from LLM!")),
      `Expected LLM response in socket output, got: ${JSON.stringify(texts)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Sender ID extraction (phone + LID)
// ═══════════════════════════════════════════════════════════════════
describe("sender ID extraction", () => {
  it("extracts both phone ID and LID from private chat message", async () => {
    /** @type {string[][]} */
    const capturedSenderIds = [];
    const { sock } = createMockBaileysSocket();

    // In private chats, remoteJid IS the sender's JID
    await adaptIncomingMessage(
      createWAMessage({ text: "hi", senderId: "12345", senderLid: "lid-abc" }),
      sock,
      async (ctx) => { capturedSenderIds.push(ctx.senderIds); },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.ok(capturedSenderIds.length > 0, "Should have captured senderIds");
    const ids = capturedSenderIds[0];
    assert.ok(ids.includes("12345"), `Should contain phone ID, got: ${ids}`);
    assert.ok(ids.includes("lid-abc"), `Should contain LID, got: ${ids}`);
  });

  it("extracts participant IDs from group message", async () => {
    /** @type {string[][]} */
    const capturedSenderIds = [];
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        text: "hello group",
        chatId: "e2e-group-sender@g.us",
        senderId: "55555",
        senderLid: "lid-group",
        isGroup: true,
      }),
      sock,
      async (ctx) => { capturedSenderIds.push(ctx.senderIds); },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const ids = capturedSenderIds[0];
    assert.ok(ids.includes("55555"), `Should contain participant phone ID, got: ${ids}`);
    assert.ok(ids.includes("lid-group"), `Should contain participant LID, got: ${ids}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Filtering: status broadcasts and fromMe messages
// ═══════════════════════════════════════════════════════════════════
describe("message filtering", () => {
  it("ignores status@broadcast messages", async () => {
    let handlerCalled = false;
    const { sock } = createMockBaileysSocket();
    const msg = createWAMessage({ text: "status update", chatId: "status@broadcast" });

    await adaptIncomingMessage(msg, sock, async () => {
      handlerCalled = true;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.equal(handlerCalled, false, "Handler should not be called for status broadcasts");
  });

  it("ignores messages with empty content", async () => {
    let handlerCalled = false;
    const { sock } = createMockBaileysSocket();
    // Message with no text, no media — empty message field
    const msg = /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
      key: { remoteJid: "test@s.whatsapp.net", fromMe: false, id: "msg-empty" },
      message: {},
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "User",
    }));

    await adaptIncomingMessage(msg, sock, async () => {
      handlerCalled = true;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.equal(handlerCalled, false, "Handler should not be called for empty messages");
  });

  it("ignores reaction-message upserts when called directly", async () => {
    let handlerCalled = false;
    const { sock } = createMockBaileysSocket();
    const msg = /** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "120363042584279820@g.us",
        fromMe: false,
        id: "reaction-upsert-1",
        participant: "213597330374785@lid",
      },
      message: {
        reactionMessage: {
          key: {
            remoteJid: "120363042584279820@g.us",
            fromMe: true,
            id: "3EB059407A39C3E611C2B4",
          },
          text: "👁",
        },
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "Marco D'Agostini",
    });

    await adaptIncomingMessage(msg, sock, async () => {
      handlerCalled = true;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.equal(handlerCalled, false, "Handler should not be called for reaction upserts");
  });

  it("drops group text messages prefixed with // before they reach the app", async () => {
    const chatId = "e2e-ignore-text@g.us";
    await seedChat(testDb, chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET respond_on = 'any' WHERE chat_id = ${chatId}`;

    mockServer.clearRequests();
    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        text: "// operator note",
        chatId,
        isGroup: true,
        senderId: "e2e-ignore-user",
      }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const { rows } = await testDb.sql`SELECT COUNT(*)::int AS count FROM messages WHERE chat_id = ${chatId}`;
    const messageCount = /** @type {{ count: number }} */ (rows[0]).count;

    assert.equal(messageCount, 0, "Ignored messages should not be persisted");
    assert.deepEqual(getSentMessages(), [], "Ignored messages should not produce socket output");
    assert.deepEqual(mockServer.getRequests(), [], "Ignored messages should not call the LLM");
  });

  it("drops media captions prefixed with // before downloading or storing media", async () => {
    const chatId = "e2e-ignore-caption@g.us";
    await seedChat(testDb, chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET respond_on = 'any' WHERE chat_id = ${chatId}`;

    let downloadCalled = false;
    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        chatId,
        isGroup: true,
        senderId: "e2e-ignore-user",
        image: { mimetype: "image/jpeg", caption: "// hidden caption" },
      }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
      undefined,
      async () => {
        downloadCalled = true;
        return Buffer.from("ignored-image");
      },
    );

    const { rows } = await testDb.sql`SELECT COUNT(*)::int AS count FROM messages WHERE chat_id = ${chatId}`;
    const messageCount = /** @type {{ count: number }} */ (rows[0]).count;

    assert.equal(downloadCalled, false, "Ignored captions should short-circuit before media download");
    assert.equal(messageCount, 0, "Ignored captioned media should not be persisted");
    assert.deepEqual(getSentMessages(), [], "Ignored captioned media should not produce socket output");
    assert.deepEqual(mockServer.getRequests(), [], "Ignored captioned media should not call the LLM");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Group detection
// ═══════════════════════════════════════════════════════════════════
describe("group detection", () => {
  it("sets isGroup=true for @g.us JIDs", async () => {
    /** @type {boolean | null} */
    let capturedIsGroup = null;
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "hi", chatId: "e2e-group-detect@g.us", isGroup: true }),
      sock,
      async (ctx) => { capturedIsGroup = ctx.facts.isGroup; },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.equal(capturedIsGroup, true);
  });

  it("sets isGroup=false for @s.whatsapp.net JIDs", async () => {
    /** @type {boolean | null} */
    let capturedIsGroup = null;
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "hi", chatId: "e2e-private-detect@s.whatsapp.net" }),
      sock,
      async (ctx) => { capturedIsGroup = ctx.facts.isGroup; },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.equal(capturedIsGroup, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Quote / reply-to extraction
// ═══════════════════════════════════════════════════════════════════
describe("quote extraction", () => {
  it("passes current and quoted identity through the adapter", async () => {
    /** @type {ChatTurn | null} */
    let capturedCtx = null;
    const { sock } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({
        text: "What did they say?",
        chatId: "e2e-quote@s.whatsapp.net",
        senderName: "Current User",
        quotedText: "Original message",
        quotedSenderId: "99999",
      }),
      sock,
      async (ctx) => { capturedCtx = ctx; },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.ok(capturedCtx, "Handler should have been called");
    assert.equal(capturedCtx.senderName, "Current User");
    assert.equal(capturedCtx.facts.quotedSenderId, "99999");
    assert.equal(capturedCtx.facts.quotedSenderJid, "99999@s.whatsapp.net");

    const quoteBlock = capturedCtx.content.find(b => b.type === "quote");
    assert.ok(quoteBlock, "Should have a quote content block");
    assert.ok(
      /** @type {QuoteContentBlock} */ (quoteBlock).content.some(
        b => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "Original message",
      ),
      "Quote should contain the original text",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Command execution through full pipeline
// ═══════════════════════════════════════════════════════════════════
describe("command through adapter", () => {
  // In private chats, chatId = senderId@s.whatsapp.net — sender must be master
  const chatId = "master-user@s.whatsapp.net";

  before(async () => {
    await seedChat(testDb, chatId);
  });

  it("processes !s command sent as a WAMessage", async () => {
    const { sock, getTextMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "!s enabled on" }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const texts = getTextMessages();
    assert.ok(
      texts.some(t => t.toLowerCase().includes("enabled")),
      `Should confirm enabling, got: ${JSON.stringify(texts)}`,
    );
  });

  it("bot responds to subsequent message after enabling", async () => {
    mockServer.addResponses("Hello via adapter!");

    const { sock, getTextMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Hey" }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const texts = getTextMessages();
    assert.ok(
      texts.some(t => t.includes("Hello via adapter!")),
      `Expected LLM response, got: ${JSON.stringify(texts)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Tool call through full pipeline with socket output
// ═══════════════════════════════════════════════════════════════════
describe("tool call through adapter", () => {
  const senderId = "e2e-tool-user";
  const chatId = `${senderId}@s.whatsapp.net`;

  before(async () => {
    await seedChat(testDb, chatId, { enabled: true });
  });

  it("executes tool call and returns final response via socket", async () => {
    mockServer.addResponses(
      {
        tool_calls: [{
          id: "call_e2e_001",
          type: "function",
          function: {
            name: "run_javascript",
            arguments: JSON.stringify({ code: "() => 'e2e-result'" }),
          },
        }],
      },
      "The result is e2e-result",
    );

    const { sock, getTextMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Run some code", senderId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const texts = getTextMessages();
    assert.ok(
      texts.some(t => t.includes("The result is e2e-result")),
      `Expected final LLM reply, got: ${JSON.stringify(texts)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Presence updates flow through the socket
// ═══════════════════════════════════════════════════════════════════
describe("presence updates", () => {
  // Use default senderId (master-user) so chatId = master-user@s.whatsapp.net
  const chatId = "master-user@s.whatsapp.net";

  it("sends composing and paused presence updates via socket", async () => {
    // Chat was already enabled by the command test above; ensure it exists
    await seedChat(testDb, chatId, { enabled: true });
    mockServer.addResponses("done");

    const { sock, getPresenceUpdates } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "hi" }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const updates = getPresenceUpdates();
    assert.ok(
      updates.some(u => u.presence === "composing" && u.chatId === chatId),
      `Should have sent composing update, got: ${JSON.stringify(updates)}`,
    );
    assert.ok(
      updates.some(u => u.presence === "paused" && u.chatId === chatId),
      `Should have sent paused update, got: ${JSON.stringify(updates)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Timestamp parsing
// ═══════════════════════════════════════════════════════════════════
describe("timestamp parsing", () => {
  it("parses numeric timestamp from WAMessage", async () => {
    const unixTime = 1700000000;

    /** @type {Date | null} */
    let capturedTimestamp = null;
    const { sock } = createMockBaileysSocket();

    const msg = createWAMessage({ text: "time check", chatId: "e2e-ts@s.whatsapp.net", timestamp: unixTime });

    await adaptIncomingMessage(msg, sock, async (ctx) => {
      capturedTimestamp = ctx.timestamp;
    }, testConfirmRegistry, testUserResponseRegistry);

    assert.ok(capturedTimestamp, "Should have captured timestamp");
    assert.equal(capturedTimestamp.getTime(), unixTime * 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. Bot identity extraction stays behind the semantic facts boundary
// ═══════════════════════════════════════════════════════════════════
describe("bot mention detection", () => {
  it("marks both phone ID and LID mentions as addressedToBot and strips the prefix", async () => {
    /** @type {ChatTurn[]} */
    const capturedTurns = [];
    const { sock } = createMockBaileysSocket({ selfId: "bot-123", selfLid: "bot-lid-456" });

    await adaptIncomingMessage(
      createWAMessage({ text: "@bot-123 hi", chatId: "e2e-self@g.us", isGroup: true }),
      sock,
      async (ctx) => {
        capturedTurns.push(ctx);
      },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    await adaptIncomingMessage(
      createWAMessage({ text: "@bot-lid-456 hi", chatId: "e2e-self@g.us", isGroup: true }),
      sock,
      async (ctx) => {
        capturedTurns.push(ctx);
      },
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    assert.equal(capturedTurns.length, 2, "Should have captured both turns");
    assert.equal(capturedTurns[0].facts.addressedToBot, true);
    assert.equal(capturedTurns[1].facts.addressedToBot, true);
    assert.equal(capturedTurns[0].content[0].type, "text");
    assert.equal(capturedTurns[1].content[0].type, "text");
    assert.equal(/** @type {TextContentBlock} */ (capturedTurns[0].content[0]).text, "hi");
    assert.equal(/** @type {TextContentBlock} */ (capturedTurns[1].content[0]).text, "hi");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. Markdown with code → socket receives [text, image, text]
// ═══════════════════════════════════════════════════════════════════
describe("markdown code renders as image in socket output", () => {
  const senderId = "e2e-md-code";
  const chatId = `${senderId}@s.whatsapp.net`;

  before(async () => {
    await seedChat(testDb, chatId, { enabled: true });
  });

  it("LLM markdown with code block produces [text, image, text] on socket", async () => {
    const llmResponse = `Here is a snippet:

\`\`\`javascript
function greet(name) {
  const msg = "Hello, " + name;
  console.log(msg);
  return msg;
}
greet("world");
\`\`\`

Hope that helps!`;
    mockServer.addResponses(llmResponse);

    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Show me code", senderId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const msgs = getSentMessages();

    // Classify each socket message
    const classified = msgs.map(m => {
      if (m.msg.image != null) return "image";
      if (typeof m.msg.text === "string") return "text";
      return "other";
    });

    // There should be at least: text (before code), image (code), text (after code)
    const textMsgs = classified.filter(t => t === "text");
    const imageMsgs = classified.filter(t => t === "image");

    assert.ok(
      imageMsgs.length >= 1,
      `Expected at least 1 image for code block, got ${imageMsgs.length}. Classified: ${JSON.stringify(classified)}`,
    );

    assert.ok(
      textMsgs.length >= 2,
      `Expected at least 2 text messages (before+after code), got ${textMsgs.length}. Classified: ${JSON.stringify(classified)}`,
    );

    // Image should be a Buffer (PNG)
    const imageMsg = msgs.find(m => m.msg.image != null);
    assert.ok(
      Buffer.isBuffer(imageMsg?.msg.image),
      "Code block image should be a Buffer",
    );

    // Verify order: first text before first image, last text after last image
    const firstImageIdx = classified.indexOf("image");
    const firstTextIdx = classified.indexOf("text");
    const lastTextIdx = classified.lastIndexOf("text");

    assert.ok(
      firstTextIdx < firstImageIdx,
      `Text should appear before image. Order: ${JSON.stringify(classified)}`,
    );
    assert.ok(
      lastTextIdx > firstImageIdx,
      `Text should appear after image. Order: ${JSON.stringify(classified)}`,
    );
  });

  it("LLM markdown without code block sends only text (no images)", async () => {
    mockServer.addResponses("Just **bold** and _italic_ text, no code.");

    const { sock, getSentMessages } = createMockBaileysSocket();

    await adaptIncomingMessage(
      createWAMessage({ text: "Tell me something", senderId }),
      sock,
      handleMessage,
      testConfirmRegistry,
      testUserResponseRegistry,
    );

    const msgs = getSentMessages();
    const imageMsgs = msgs.filter(m => m.msg.image != null);
    const textMsgs = msgs.filter(m => typeof m.msg.text === "string");

    assert.equal(
      imageMsgs.length, 0,
      `Should have 0 images for plain markdown, got ${imageMsgs.length}`,
    );
    assert.ok(
      textMsgs.length >= 1,
      `Should have at least 1 text message, got ${textMsgs.length}`,
    );
  });
});

}); // end describe("e2e adapter")
