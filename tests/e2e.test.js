// ── Env vars MUST be set before any import that triggers config.js ──
process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createIncomingContext,
  createMockLlmServer,
  createTestDb,
} from "./helpers.js";
import { setDb, closeAllDbs } from "../db.js";

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {typeof import("../index.js").handleMessage} */
let handleMessage;
/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;

/**
 * Pre-create a chat row in the test DB
 * @param {string} chatId
 * @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options]
 */
async function seedChat(chatId, options = {}) {
  const enabled = options.enabled ?? false;
  const systemPrompt = options.systemPrompt ?? null;
  const model = options.model ?? null;
  await testDb.sql`INSERT INTO chats(chat_id, is_enabled, system_prompt, model)
    VALUES (${chatId}, ${enabled}, ${systemPrompt}, ${model})
    ON CONFLICT (chat_id) DO NOTHING`;
}

// ── Global setup / teardown ──

before(async () => {
  // 1. In-memory DB → seed the cache so initStore() uses it
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  // 2. Mock LLM server → set BASE_URL before config.js is loaded
  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  // 3. Dynamic import of index.js (triggers config, actions, store)
  const indexModule = await import("../index.js");
  handleMessage = indexModule.handleMessage;
});

after(async () => {
  await mockServer?.close();
  await closeAllDbs();
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 0: createIncomingContext provides all required capabilities
// ═══════════════════════════════════════════════════════════════════
describe("createIncomingContext shape", () => {
  it("includes reactToMessage, sendPoll, and confirm", () => {
    const { context } = createIncomingContext();
    assert.equal(typeof context.reactToMessage, "function", "should have reactToMessage");
    assert.equal(typeof context.sendPoll, "function", "should have sendPoll");
    assert.equal(typeof context.confirm, "function", "should have confirm");
  });

  it("reactToMessage records response", async () => {
    const { context, responses } = createIncomingContext();
    await context.reactToMessage("👍");
    assert.ok(responses.some(r => r.type === "reactToMessage" && r.text === "👍"));
  });

  it("sendPoll records response", async () => {
    const { context, responses } = createIncomingContext();
    await context.sendPoll("Vote", ["A", "B"], 1);
    assert.ok(responses.some(r => r.type === "sendPoll"));
  });

  it("confirm records response and returns true by default", async () => {
    const { context, responses } = createIncomingContext();
    const result = await context.confirm("Are you sure?");
    assert.equal(result, true);
    assert.ok(responses.some(r => r.type === "confirm" && r.text === "Are you sure?"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 1: Enable / disable chat flow
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 1: Enable/disable chat flow", () => {
  const chatId = "s1-chat";

  before(async () => {
    await seedChat(chatId);
  });

  it("master user enables chat with !enable", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!enable" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0, "Bot should respond");
    assert.ok(
      responses.some((r) => r.text.toLowerCase().includes("enabled")),
      "Should confirm enabling",
    );
  });

  it("bot responds via LLM to a text message in an enabled chat", async () => {
    mockServer.addResponses("Hello from the LLM!");

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Hey there" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0, "Bot should respond");
    assert.ok(
      responses.some((r) => r.text.includes("Hello from the LLM!")),
      "Response should include LLM output",
    );
  });

  it("master user disables chat with !disable", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!disable" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0, "Bot should respond");
    assert.ok(
      responses.some((r) => r.text.toLowerCase().includes("disabled")),
      "Should confirm disabling",
    );
  });

  it("bot does NOT respond to messages in a disabled chat", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Hello?" }],
    });
    await handleMessage(context);

    assert.equal(responses.length, 0, "Bot should not respond when disabled");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 2: Non-master cannot enable / disable
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 2: Non-master cannot enable/disable", () => {
  const chatId = "s2-chat";

  before(async () => {
    await seedChat(chatId);
  });

  it("rejects !enable from non-master user", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      senderIds: ["non-master-user"],
      content: [{ type: "text", text: "!enable" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0, "Bot should respond with error");
    assert.ok(
      responses.some((r) => r.text.toLowerCase().includes("master")),
      "Should mention master permissions",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 3: Unknown command
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 3: Unknown command", () => {
  it("responds with error for unknown command", async () => {
    const { context, responses } = createIncomingContext({
      chatId: "s3-chat",
      content: [{ type: "text", text: "!foobar" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0, "Bot should respond");
    assert.ok(
      responses.some((r) => r.text.toLowerCase().includes("unknown command")),
      "Should mention unknown command",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 4: Set and get system prompt
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 4: Set and get system prompt", () => {
  const chatId = "s4-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("sets system prompt with !set prompt", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!set prompt pirate" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.includes("pirate")),
      "Should confirm prompt containing 'pirate'",
    );
  });

  it("retrieves system prompt with !get prompt", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!get prompt" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.includes("pirate")),
      "Should return prompt containing 'pirate'",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 5: Set and get model
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 5: Set and get model", () => {
  const chatId = "s5-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("sets model with !set model", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!set model gpt-4.1-mini" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.includes("gpt-4.1-mini")),
      "Should confirm model name",
    );
  });

  it("retrieves model with !get model", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!get model" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.includes("gpt-4.1-mini")),
      "Should return model name",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 6: New conversation clears history
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 6: New conversation clears history", () => {
  const chatId = "s6-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("after !clear the next LLM call sees only the new message", async () => {
    // Step 1 — send a message so the DB has history
    mockServer.addResponses("First response");
    const { context: ctx1, responses: r1 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Remember this" }],
    });
    await handleMessage(ctx1);
    assert.ok(r1.some((r) => r.text.includes("First response")));

    // Step 2 — clear history
    const { context: ctx2, responses: r2 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!clear" }],
    });
    await handleMessage(ctx2);
    assert.ok(
      r2.some((r) => r.text.toLowerCase().includes("clear")),
      "Should confirm clearing",
    );

    // Step 3 — send another message; LLM should only see 1 user message
    const requestCountBefore = mockServer.getRequests().length;
    mockServer.addResponses("Second response");
    const { context: ctx3, responses: r3 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Fresh start" }],
    });
    await handleMessage(ctx3);
    assert.ok(r3.some((r) => r.text.includes("Second response")));

    const lastRequest = mockServer.getRequests()[requestCountBefore];
    const userMessages = lastRequest.messages.filter((m) => m.role === "user");
    assert.equal(
      userMessages.length,
      1,
      "LLM should see only 1 user message after history clear",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 7: Show info
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 7: Show info", () => {
  const chatId = "s7-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("!info shows chat ID, enabled status, and sender info", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!info" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    const allText = responses.map((r) => r.text).join(" ");
    assert.ok(allText.includes(chatId), "Should contain chat ID");
    assert.ok(
      allText.toLowerCase().includes("enabled"),
      "Should contain enabled status",
    );
    assert.ok(
      allText.toLowerCase().includes("sender"),
      "Should contain sender info",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 8: Run JavaScript via LLM tool call
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 8: Run JavaScript via tool call", () => {
  const chatId = "s8-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("executes run_javascript tool call and returns final LLM reply", async () => {
    // First LLM call → tool_call; second (after execution) → text
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_mock_js_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "({chatId}) => chatId" }),
            },
          },
        ],
      },
      `The chat ID is ${chatId}`,
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "What is the chat ID?" }],
    });
    await handleMessage(context);

    // Expect at least: tool executing msg, tool result msg, final LLM reply
    assert.ok(
      responses.length >= 3,
      `Expected >= 3 responses, got ${responses.length}`,
    );
    assert.ok(
      responses.some((r) => r.text.includes("run_javascript")),
      "Should show tool execution notification",
    );
    assert.ok(
      responses.some((r) => r.text.includes(chatId)),
      "Tool result should contain the chat ID",
    );
    assert.ok(
      responses.some((r) => r.text.includes(`The chat ID is ${chatId}`)),
      "Final reply should contain result",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 8b: Tool call depth guard
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 8b: Tool call depth guard", () => {
  const chatId = "s8b-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("stops processing after MAX_TOOL_CALL_DEPTH iterations", async () => {
    // Queue 15 tool-call responses using a non-existent action.
    // Tool errors always set continueProcessing=true, so without a depth guard
    // the loop would continue for all 15 + hit the server error.
    const toolCallResponses = Array.from({ length: 15 }, (_, i) => ({
      tool_calls: [
        {
          id: `call_depth_${String(i).padStart(3, "0")}`,
          type: "function",
          function: {
            name: "nonexistent_action_for_depth_test",
            arguments: "{}",
          },
        },
      ],
    }));
    mockServer.addResponses(...toolCallResponses);

    const requestsBefore = mockServer.getRequests().length;
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "trigger depth test" }],
    });
    await handleMessage(context);

    const requestsAfter = mockServer.getRequests().length;
    const totalRequests = requestsAfter - requestsBefore;

    // With depth guard at 10: 1 initial + 10 continuations = 11 max
    // Without guard: would attempt all 15+ continuations
    assert.ok(
      totalRequests <= 11,
      `Expected at most 11 LLM requests (depth guard at 10), got ${totalRequests}`,
    );

    // Should have a depth limit warning in responses
    assert.ok(
      responses.some((r) => r.text.toLowerCase().includes("depth") || r.text.toLowerCase().includes("limit")),
      "Should warn about depth limit being reached",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 9: Group chat — only responds when mentioned
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 9: Group chat — only responds when mentioned", () => {
  const chatId = "s9-chat@g.us";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("does NOT respond in group when bot is not mentioned", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      isGroup: true,
      content: [{ type: "text", text: "Hello everyone" }],
    });
    await handleMessage(context);

    assert.equal(responses.length, 0, "Should not respond when not mentioned");
  });

  it("responds in group when bot is @mentioned", async () => {
    mockServer.addResponses("Hi from the bot!");

    const { context, responses } = createIncomingContext({
      chatId,
      isGroup: true,
      content: [{ type: "text", text: "@bot-123 what's up?" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0, "Should respond when mentioned");
    assert.ok(responses.some((r) => r.text.includes("Hi from the bot!")));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 10: Private chat — always responds when enabled
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 10: Private chat — always responds when enabled", () => {
  const chatId = "s10-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("responds to any text in an enabled private chat", async () => {
    mockServer.addResponses("Private chat response");

    const { context, responses } = createIncomingContext({
      chatId,
      isGroup: false,
      content: [{ type: "text", text: "Hi" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(responses.some((r) => r.text.includes("Private chat response")));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 11: Adapter — getMessageContent extraction
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 11: getMessageContent extraction", () => {
  /** @type {typeof import("../whatsapp-adapter.js").getMessageContent} */
  let getMessageContent;

  before(async () => {
    const adapter = await import("../whatsapp-adapter.js");
    getMessageContent = adapter.getMessageContent;
  });

  it("extracts plain text conversation message", async () => {
    const msg = /** @type {any} */ ({
      message: { conversation: "Hello world" },
    });
    const { content } = await getMessageContent(msg);

    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    assert.equal(/** @type {any} */ (content[0]).text, "Hello world");
  });

  it("extracts extendedTextMessage", async () => {
    const msg = /** @type {any} */ ({
      message: { extendedTextMessage: { text: "Extended hello" } },
    });
    const { content } = await getMessageContent(msg);

    assert.ok(
      content.some(
        (b) => b.type === "text" && /** @type {any} */ (b).text === "Extended hello",
      ),
    );
  });

  it("extracts quoted message with reply text", async () => {
    const msg = /** @type {any} */ ({
      message: {
        extendedTextMessage: {
          text: "My reply",
          contextInfo: {
            quotedMessage: { conversation: "Original message" },
          },
        },
      },
    });
    const { content } = await getMessageContent(msg);

    assert.ok(
      content.some((b) => b.type === "quote"),
      "Should have a quote block",
    );
    assert.ok(
      content.some(
        (b) => b.type === "text" && /** @type {any} */ (b).text === "My reply",
      ),
      "Should have reply text",
    );

    const quote = /** @type {any} */ (content.find((b) => b.type === "quote"));
    assert.ok(
      quote.content.some(
        (b) => b.type === "text" && b.text === "Original message",
      ),
      "Quote should contain original text",
    );
  });
});
