// ── Env vars MUST be set before any import that triggers config.js ──
process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createIncomingContext,
  createMockLlmServer,
  createTestDb,
  seedChat as seedChat_,
} from "./helpers.js";
import { setDb } from "../db.js";
import { startHtmlServer, stopHtmlServer } from "../html-server.js";

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: IncomingContext) => Promise<void>} */
let handleMessage;
/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(testDb, chatId, options);

// ── All tests run serially to prevent concurrent mock-server races ──

describe("e2e", { concurrency: 1 }, () => {

const CACHE_PATH = path.resolve("data/models.json");

before(async () => {
  // 0. Seed models cache so setModel validation passes
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify([
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  ]));

  // 1. In-memory DB → seed the cache so initStore() uses it
  testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  // 2. Mock LLM server
  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  // 3. Create handler with own llmClient (avoids shared module-level state)
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

  it("master user enables chat with !config enabled true", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!config enabled true" }],
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

  it("master user disables chat with !config enabled false", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!config enabled false" }],
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

  it("rejects !config enabled from non-master user", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      senderIds: ["non-master-user"],
      content: [{ type: "text", text: "!config enabled true" }],
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

  it("sets system prompt with !config system_prompt", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!config system_prompt pirate" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.includes("pirate")),
      "Should confirm prompt containing 'pirate'",
    );
  });

  it("retrieves system prompt with !config system_prompt (no value)", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!config system_prompt" }],
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
    // Re-seed models cache (may have been deleted by action-test-functions)
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify([
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
    ]));
  });

  it("sets model with !config model", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!config model gpt-4.1-mini" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.includes("Model set to")),
      `Should confirm model was set, got: ${JSON.stringify(responses.map(r => r.text))}`,
    );
  });

  it("retrieves model with !config", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!config" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.includes("gpt-4.1-mini")),
      "Should return model name in info output",
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

  it("!config shows chat ID, enabled status, and sender info", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!config" }],
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
    // Enable debug so tool call output is visible in responses
    await testDb.sql`UPDATE chats SET debug_until = '9999-01-01' WHERE chat_id = ${chatId}`;
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

  after(() => {
    assert.equal(
      mockServer.pendingResponses(),
      0,
      `Scenario 8b leaked ${mockServer.pendingResponses()} unconsumed mock responses`,
    );
  });

  it("offers confirmation at depth limit; stops when user declines", async () => {
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
    const scope = mockServer.addResponses(...toolCallResponses);

    const requestsBefore = mockServer.getRequests().length;
    // confirm returns false → user declines continuation
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "trigger depth test" }],
      confirm: async (message) => {
        responses.push({ type: "confirm", text: message });
        return false;
      },
    });
    await handleMessage(context);
    scope.clear();

    const requestsAfter = mockServer.getRequests().length;
    const totalRequests = requestsAfter - requestsBefore;

    // With depth guard at 10: 1 initial + 10 continuations = 11 max
    assert.ok(
      totalRequests <= 11,
      `Expected at most 11 LLM requests (depth guard at 10), got ${totalRequests}`,
    );

    // Should have asked via confirm (not just a static reply)
    const confirmMessages = responses.filter((r) => r.type === "confirm");
    assert.ok(
      confirmMessages.length > 0,
      "Should ask user for confirmation at depth limit",
    );
    assert.ok(
      confirmMessages[0].text.toLowerCase().includes("depth") || confirmMessages[0].text.toLowerCase().includes("limit"),
      "Confirm message should mention depth/limit",
    );
  });

  it("continues processing when user confirms at depth limit", async () => {
    let confirmCount = 0;
    // Queue 25 tool-call responses — enough for 2 depth-limit cycles
    const toolCallResponses = Array.from({ length: 25 }, (_, i) => ({
      tool_calls: [
        {
          id: `call_cont_${String(i).padStart(3, "0")}`,
          type: "function",
          function: {
            name: "nonexistent_action_for_cont_test",
            arguments: "{}",
          },
        },
      ],
    }));
    // Final response: plain text to end the loop
    toolCallResponses.push(/** @type {any} */ ({ content: "Done!" }));
    const scope = mockServer.addResponses(...toolCallResponses);

    const requestsBefore = mockServer.getRequests().length;
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "trigger continuation test" }],
      confirm: async (message) => {
        confirmCount++;
        responses.push({ type: "confirm", text: message });
        // Approve first time, decline second time
        return confirmCount <= 1;
      },
    });
    await handleMessage(context);
    scope.clear();

    const requestsAfter = mockServer.getRequests().length;
    const totalRequests = requestsAfter - requestsBefore;

    // First cycle: 11 requests (1 initial + 10 continuations)
    // User confirms → second cycle starts, another 10 continuations
    // User declines at second limit → stops
    // Total: 11 + 10 = 21
    assert.ok(
      totalRequests > 11,
      `Expected more than 11 requests after user confirmed continuation, got ${totalRequests}`,
    );
    assert.ok(
      totalRequests <= 22,
      `Expected at most 22 requests (two depth cycles + decline), got ${totalRequests}`,
    );

    // Should have been asked twice
    const confirmMessages = responses.filter((r) => r.type === "confirm");
    assert.equal(confirmMessages.length, 2, "Should ask user twice (confirm once, decline once)");
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
// Scenario 11: Group — stores messages even when bot doesn't respond
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 11: Group stores messages even when not responding", () => {
  const chatId = "s11-chat@g.us";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("stores a non-triggering message so it appears in later history", async () => {
    // Send a message without mentioning the bot — bot should NOT respond
    const { context: ctx1, responses: r1 } = createIncomingContext({
      chatId,
      isGroup: true,
      content: [{ type: "text", text: "Hey guys, check this out" }],
      senderName: "Alice",
    });
    await handleMessage(ctx1);
    assert.equal(r1.length, 0, "Bot should not respond when not mentioned");

    // Now mention the bot — it should respond, and the previous message should be in history
    mockServer.addResponses("I can see Alice said something earlier!");

    const { context: ctx2, responses: r2 } = createIncomingContext({
      chatId,
      isGroup: true,
      content: [{ type: "text", text: "@bot-123 what did Alice say?" }],
    });
    await handleMessage(ctx2);

    assert.ok(r2.length > 0, "Bot should respond when mentioned");

    // Verify the first message was stored by checking the LLM request
    const requests = mockServer.getRequests();
    const lastRequest = requests[requests.length - 1];
    const allContent = JSON.stringify(lastRequest.messages);
    assert.ok(
      allContent.includes("Hey guys, check this out"),
      `Previous non-triggered message should be in history, got: ${allContent.slice(0, 500)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 12: Debug mode — gates tool call verbose output
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 12: Debug mode gates tool call output", () => {
  const chatIdOff = "s12-debug-off";
  const chatIdOn = "s12-debug-on";

  before(async () => {
    await seedChat(chatIdOff, { enabled: true });
    await seedChat(chatIdOn, { enabled: true });
    // Enable debug mode for the "on" chat
    await testDb.sql`UPDATE chats SET debug_until = '9999-01-01' WHERE chat_id = ${chatIdOn}`;
  });

  it("shows compact tool call and result when debug is off", async () => {
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_dbg_off_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'hello'" }),
            },
          },
        ],
      },
      "Final answer",
    );

    const { context, responses } = createIncomingContext({
      chatId: chatIdOff,
      content: [{ type: "text", text: "Test debug off" }],
    });
    await handleMessage(context);

    // Should have the final LLM reply
    assert.ok(
      responses.some((r) => r.text.includes("Final answer")),
      "Should have the final LLM reply",
    );
    // Should show compact tool call with formatToolCall detail appended
    assert.ok(
      responses.some((r) => r.text.startsWith("🔧 run_javascript: ")),
      `Should show compact tool call with formatted detail, got: ${responses.map(r=>r.text).join(" | ")}`,
    );
    // Should show compact result (no bold *Result* header)
    assert.ok(
      responses.some((r) => r.text.startsWith("✅") && !r.text.includes("*Result*")),
      `Should show compact result without verbose header, got: ${responses.map(r=>r.text).join(" | ")}`,
    );
  });

  it("truncated result shows remaining char/line count", async () => {
    // Generate a result longer than 200 chars with multiple lines
    const longResult = "Line one of the output\\n".repeat(20);
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_dbg_trunc_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: `() => "${longResult}"` }),
            },
          },
        ],
      },
      "Summary of long result",
    );

    const { context, responses } = createIncomingContext({
      chatId: chatIdOff,
      content: [{ type: "text", text: "Get long output" }],
    });
    await handleMessage(context);

    const truncatedResponse = responses.find((r) => r.text.startsWith("✅") && r.text.includes("…"));
    assert.ok(
      truncatedResponse,
      `Should have a truncated result, got: ${responses.map(r=>r.text).join(" | ")}`,
    );
    // Should indicate how much more content there is
    assert.ok(
      /\d+/.test(truncatedResponse.text.slice(truncatedResponse.text.indexOf("…"))),
      `Truncated result should show remaining count after '…', got: ${truncatedResponse.text}`,
    );
  });

  it("shows full result as reply for non-autoContinue actions when debug is off", async () => {
    // chat_settings does NOT have autoContinue, so result is the final answer
    mockServer.addResponses({
      tool_calls: [
        {
          id: "call_dbg_nocont_001",
          type: "function",
          function: {
            name: "chat_settings",
            arguments: JSON.stringify({ setting: "" }),
          },
        },
      ],
    });

    const { context, responses } = createIncomingContext({
      chatId: chatIdOff,
      content: [{ type: "text", text: "Show info" }],
    });
    await handleMessage(context);

    // Non-autoContinue result should be shown as a reply (final answer)
    const resultReply = responses.find(
      (r) => r.type === "replyToMessage" && r.text.includes(chatIdOff),
    );
    assert.ok(
      resultReply,
      `Should reply with full result for non-autoContinue action, got: ${responses.map(r=>`[${r.type}] ${r.text}`).join(" | ")}`,
    );
  });

  it("shows only action name when action has no formatToolCall", async () => {
    mockServer.addResponses({
      tool_calls: [
        {
          id: "call_no_fmt_001",
          type: "function",
          function: {
            name: "chat_settings",
            arguments: JSON.stringify({ setting: "" }),
          },
        },
      ],
    });

    const { context, responses } = createIncomingContext({
      chatId: chatIdOff,
      content: [{ type: "text", text: "Show settings" }],
    });
    await handleMessage(context);

    // chat_settings has no formatToolCall, so compact mode should show just the name
    assert.ok(
      responses.some((r) => r.text === "🔧 chat_settings"),
      `Should show only action name without detail, got: ${responses.map(r=>r.text).join(" | ")}`,
    );
  });

  it("DOES send tool call args and results when debug is on", async () => {
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_dbg_on_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'hello'" }),
            },
          },
        ],
      },
      "Final answer debug on",
    );

    const { context, responses } = createIncomingContext({
      chatId: chatIdOn,
      content: [{ type: "text", text: "Test debug on" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some((r) => r.text.includes("Final answer debug on")),
      "Should have the final LLM reply",
    );
    assert.ok(
      responses.some((r) => r.text.includes("🔧")),
      "Tool call args should be shown when debug is on",
    );
    assert.ok(
      responses.some((r) => r.text.includes("✅ *Result*")),
      "Tool results should be shown when debug is on",
    );
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
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: { conversation: "Hello world" },
    });
    const { content } = await getMessageContent(/** @type {BaileysMessage} */ (msg));

    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    assert.equal(/** @type {TextContentBlock} */ (content[0]).text, "Hello world");
  });

  it("extracts extendedTextMessage", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: { extendedTextMessage: { text: "Extended hello" } },
    });
    const { content } = await getMessageContent(/** @type {BaileysMessage} */ (msg));

    assert.ok(
      content.some(
        (b) => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "Extended hello",
      ),
    );
  });

  it("extracts quoted message with reply text", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "My reply",
          contextInfo: {
            quotedMessage: { conversation: "Original message" },
          },
        },
      },
    });
    const { content } = await getMessageContent(/** @type {BaileysMessage} */ (msg));

    assert.ok(
      content.some((b) => b.type === "quote"),
      "Should have a quote block",
    );
    assert.ok(
      content.some(
        (b) => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "My reply",
      ),
      "Should have reply text",
    );

    const quote = /** @type {QuoteContentBlock} */ (content.find((b) => b.type === "quote"));
    assert.ok(
      quote.content.some(
        (b) => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "Original message",
      ),
      "Quote should contain original text",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Opt-in actions filtered out unless enabled
// ═══════════════════════════════════════════════════════════════════
describe("Opt-in action filtering", () => {
  const chatId = "opt-in-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("opt-in action command fails when not enabled for chat", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!compras history" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      responses.some((r) => r.text.toLowerCase().includes("unknown command")),
      `Should reject opt-in command, got: ${JSON.stringify(responses.map(r => r.text))}`,
    );
  });

  it("opt-in action works after enabling it", async () => {
    // Enable the opt-in action
    await testDb.sql`UPDATE chats SET enabled_actions = '["track_purchases"]'::jsonb WHERE chat_id = ${chatId}`;

    // The command should now be recognized (it'll fail because there's no actual
    // data, but it should NOT say "unknown command")
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "!compras history" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0);
    assert.ok(
      !responses.some((r) => r.text.toLowerCase().includes("unknown command")),
      `Should recognize opt-in command after enabling, got: ${JSON.stringify(responses.map(r => r.text))}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: HtmlContent from LLM tool call sends link URL
// ═══════════════════════════════════════════════════════════════════
describe("HtmlContent via LLM tool call", () => {
  const chatId = "html-tool-chat";
  /** @type {number} */
  let htmlPort;

  before(async () => {
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET debug_until = '9999-01-01' WHERE chat_id = ${chatId}`;
    htmlPort = await startHtmlServer(0, testDb);
    process.env.HTML_SERVER_BASE_URL = `http://127.0.0.1:${htmlPort}`;
  });

  after(async () => {
    await stopHtmlServer();
    delete process.env.HTML_SERVER_BASE_URL;
  });

  it("sends link URL to user when tool returns HtmlContent", async () => {
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_html_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({
                code: '() => ({ __brand: "html", html: "<h1>Report</h1>", title: "Sales Report" })',
              }),
            },
          },
        ],
      },
      "Here is your report!",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Generate a report" }],
    });
    await handleMessage(context);

    // Should have a response containing /page/ link
    const linkResponse = responses.find((r) => r.text.includes("/page/"));
    assert.ok(
      linkResponse,
      `Should send a page link, got: ${responses.map(r => r.text).join(" | ")}`,
    );
    assert.ok(
      linkResponse.text.includes("Sales Report"),
      `Link text should include the title, got: ${linkResponse.text}`,
    );

    // Verify the page is actually accessible
    const urlMatch = linkResponse.text.match(/(http:\/\/[^\s]+)/);
    assert.ok(urlMatch, "Should contain a URL");
    const pageRes = await fetch(urlMatch[1]);
    assert.equal(pageRes.status, 200);
    const body = await pageRes.text();
    assert.ok(body.includes("<h1>Report</h1>"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: HtmlContent from !command sends link URL
// ═══════════════════════════════════════════════════════════════════
describe("HtmlContent via !command", () => {
  const chatId = "html-cmd-chat";
  /** @type {number} */
  let htmlPort;

  before(async () => {
    await seedChat(chatId, { enabled: true });
    htmlPort = await startHtmlServer(0, testDb);
    process.env.HTML_SERVER_BASE_URL = `http://127.0.0.1:${htmlPort}`;
  });

  after(async () => {
    await stopHtmlServer();
    delete process.env.HTML_SERVER_BASE_URL;
  });

  it("sends link URL when !js returns HtmlContent", async () => {
    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: '!js () => ({ __brand: "html", html: "<p>Hello</p>", title: "Test" })' }],
    });
    await handleMessage(context);

    const linkResponse = responses.find((r) => r.text.includes("/page/"));
    assert.ok(
      linkResponse,
      `Should send a page link, got: ${responses.map(r => r.text).join(" | ")}`,
    );
    assert.ok(
      linkResponse.text.includes("Test"),
      `Link text should include the title, got: ${linkResponse.text}`,
    );
  });
});

}); // end describe("e2e")
