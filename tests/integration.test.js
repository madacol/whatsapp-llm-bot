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
import config from "../config.js";

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: IncomingContext) => Promise<void>} */
let handleMessage;
/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(testDb, chatId, options);

// ── All tests run serially to prevent concurrent mock-server races ──

describe("integration", { concurrency: 1 }, () => {

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

// ═══════════════════════════════════════════════════════════════════
// Scenario: Multi-turn conversation accumulates context
// ═══════════════════════════════════════════════════════════════════
describe("Multi-turn conversation accumulates context", () => {
  const chatId = "multi-turn-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("LLM sees all prior turns in context", async () => {
    // Turn 1
    mockServer.addResponses("I'll remember that.");
    const { context: ctx1 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "My name is Alice" }],
    });
    await handleMessage(ctx1);

    // Turn 2
    mockServer.addResponses("Got it, you like cats.");
    const { context: ctx2 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "I like cats" }],
    });
    await handleMessage(ctx2);

    // Turn 3 — verify LLM sees all previous messages
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("Sure, Alice who likes cats!");
    const { context: ctx3 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Summarize what you know about me" }],
    });
    await handleMessage(ctx3);

    const lastReq = mockServer.getRequests()[reqsBefore];
    const allContent = JSON.stringify(lastReq.messages);
    assert.ok(allContent.includes("My name is Alice"), "Should see turn 1 user message");
    assert.ok(allContent.includes("I'll remember that"), "Should see turn 1 assistant reply");
    assert.ok(allContent.includes("I like cats"), "Should see turn 2 user message");
    assert.ok(allContent.includes("Summarize what you know"), "Should see turn 3 user message");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: User sends image to text-only model with media-to-text configured
// ═══════════════════════════════════════════════════════════════════
describe("User sends image to text-only model (media-to-text converts it)", () => {
  const chatId = "media-convert-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("converts image to text via media-to-text model, then sends text to main LLM", async () => {
    const reqsBefore = mockServer.getRequests().length;
    // First response: media-to-text model describes the image
    // Second response: main LLM uses the description
    mockServer.addResponses(
      "A photo of a sunset over the ocean.",
      "Based on the image description, I can see a beautiful sunset!",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [
        { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "aGVsbG8=" },
        { type: "text", text: "Describe this image" },
      ],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("beautiful sunset")),
      `Should get LLM response, got: ${responses.map(r => `[${r.type}] ${r.text.slice(0, 80)}`).join(" | ")}`,
    );

    // Verify two LLM calls were made: one for media-to-text, one for chat
    const newReqs = mockServer.getRequests().slice(reqsBefore);
    assert.ok(newReqs.length >= 2, `Expected at least 2 LLM requests (convert + chat), got ${newReqs.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: LLM returns multiple tool calls in one turn
// ═══════════════════════════════════════════════════════════════════
describe("Multiple tool calls in a single LLM response", () => {
  const chatId = "multi-tool-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("executes all tool calls and sends results back to LLM", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_multi_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'result-A'" }),
            },
          },
          {
            id: "call_multi_002",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'result-B'" }),
            },
          },
        ],
      },
      "Both tools returned results A and B.",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Run two things at once" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("Both tools returned")),
      "Should get final LLM reply after both tools",
    );

    // Verify the second LLM request contains both tool results
    const secondReq = mockServer.getRequests()[reqsBefore + 1];
    const toolMsgs = secondReq.messages.filter(m => m.role === "tool");
    assert.equal(toolMsgs.length, 2, `Should have 2 tool result messages, got ${toolMsgs.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Error recovery across turns
// ═══════════════════════════════════════════════════════════════════
describe("Error recovery across turns", () => {
  const chatId = "error-recovery-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("bot recovers on next turn after LLM API error", async () => {
    // Turn 1 — no mock responses queued → server returns 500
    const { context: ctx1, responses: r1 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "First message" }],
    });
    await handleMessage(ctx1);
    assert.ok(r1.some(r => r.text.includes("Error")), "Should show error to user");

    // Turn 2 — normal response
    mockServer.addResponses("Back to normal!");
    const { context: ctx2, responses: r2 } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Try again" }],
    });
    await handleMessage(ctx2);

    assert.ok(
      r2.some(r => r.text.includes("Back to normal")),
      "Should recover and respond normally on next turn",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Group respond_on modes
// ═══════════════════════════════════════════════════════════════════
describe("Group respond_on modes", () => {
  it("respond_on=any: responds to every message in group", async () => {
    const chatId = "respond-any@g.us";
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET respond_on = 'any' WHERE chat_id = ${chatId}`;

    mockServer.addResponses("Responding to everything!");
    const { context, responses } = createIncomingContext({
      chatId,
      isGroup: true,
      content: [{ type: "text", text: "Hello everyone" }],
    });
    await handleMessage(context);

    assert.ok(responses.some(r => r.text.includes("Responding to everything")),
      "Should respond even without mention when respond_on=any");
  });

  it("respond_on=mention+reply: responds to reply-to-bot", async () => {
    const chatId = "respond-reply@g.us";
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET respond_on = 'mention+reply' WHERE chat_id = ${chatId}`;

    // Message without mention but quoting the bot
    mockServer.addResponses("Replying to your reply!");
    const { context, responses } = createIncomingContext({
      chatId,
      isGroup: true,
      quotedSenderId: "bot-123",
      content: [{ type: "text", text: "What did you mean?" }],
    });
    await handleMessage(context);

    assert.ok(responses.some(r => r.text.includes("Replying to your reply")),
      "Should respond when user replies to bot's message");
  });

  it("respond_on=mention+reply: ignores unrelated messages", async () => {
    const chatId = "respond-reply-ignore@g.us";
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET respond_on = 'mention+reply' WHERE chat_id = ${chatId}`;

    const { context, responses } = createIncomingContext({
      chatId,
      isGroup: true,
      content: [{ type: "text", text: "Just chatting" }],
    });
    await handleMessage(context);

    assert.equal(responses.length, 0, "Should not respond to unrelated message");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Confirmation declined stops action execution
// ═══════════════════════════════════════════════════════════════════
describe("Confirmation declined prevents action execution", () => {
  const chatId = "confirm-decline-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("action is skipped when user declines confirmation", async () => {
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_confirm_001",
            type: "function",
            function: {
              name: "run_bash",
              arguments: JSON.stringify({ command: "echo hello" }),
            },
          },
        ],
      },
      "The command was not executed.",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Run a shell command" }],
      confirm: async (message) => {
        responses.push({ type: "confirm", text: message });
        return false;  // user declines
      },
    });
    await handleMessage(context);

    // Should have asked for confirmation
    assert.ok(
      responses.some(r => r.type === "confirm"),
      "Should ask for confirmation before running bash",
    );
    // The cancelled result should mention cancellation
    assert.ok(
      responses.some(r => r.text.toLowerCase().includes("cancel") || r.text.toLowerCase().includes("denied")),
      `Should indicate action was cancelled, got: ${responses.map(r => r.text).join(" | ")}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: save_memory tool call stores memory in DB
// ═══════════════════════════════════════════════════════════════════
describe("Memory: save_memory tool call stores memory in DB", () => {
  const chatId = "mem-save-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET memory = true WHERE chat_id = ${chatId}`;
  });

  it("saves memory via tool call and delivers final LLM reply silently", async () => {
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_mem_save_001",
            type: "function",
            function: {
              name: "save_memory",
              arguments: JSON.stringify({ content: "User likes cats" }),
            },
          },
        ],
      },
      "Got it, I'll remember that!",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "I really love cats" }],
    });
    await handleMessage(context);

    // Memory row should exist in DB
    const { rows } = await testDb.sql`SELECT * FROM memories WHERE chat_id = ${chatId}`;
    assert.ok(rows.length > 0, "Memory should be stored in DB");
    assert.equal(rows[0].content, "User likes cats");

    // Final LLM text reply should be visible
    assert.ok(
      responses.some(r => r.text.includes("Got it, I'll remember that!")),
      `Should deliver final LLM reply, got: ${responses.map(r => r.text).join(" | ")}`,
    );

    // silent: true suppresses the result notification (no ✅ message)
    assert.ok(
      !responses.some(r => r.text.startsWith("✅")),
      `Should not show result notification for silent action, got: ${responses.map(r => r.text).join(" | ")}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Saved memories are injected into the system prompt
// ═══════════════════════════════════════════════════════════════════
describe("Memory: injected into system prompt", () => {
  const chatId = "mem-inject-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET memory = true, memory_threshold = -2 WHERE chat_id = ${chatId}`;
    // Pre-insert a memory with embedding so the vector similarity path finds it
    await testDb.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, 'User prefers dark mode', ${JSON.stringify([1, 0, 0])}::vector, to_tsvector('english', 'User prefers dark mode'))
    `;
  });

  it("system prompt contains relevant memories for matching message", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("Sure, I know your preferences!");

    const { context } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "What are my preferences?" }],
    });
    await handleMessage(context);

    const llmRequest = mockServer.getRequests()[reqsBefore];
    const systemMsg = llmRequest.messages.find(m => m.role === "system");
    assert.ok(systemMsg, "Should have a system message");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(
      systemText.includes("## Relevant memories"),
      `System prompt should contain memory section, got: ${systemText.slice(-300)}`,
    );
    assert.ok(
      systemText.includes("User prefers dark mode"),
      `System prompt should contain the memory content, got: ${systemText.slice(-300)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Memories NOT injected when memory is disabled
// ═══════════════════════════════════════════════════════════════════
describe("Memory: NOT injected when memory is disabled", () => {
  const chatId = "mem-disabled-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
    // memory defaults to false — do NOT set it to true
    await testDb.sql`UPDATE chats SET memory_threshold = -2 WHERE chat_id = ${chatId}`;
    await testDb.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, 'User prefers light mode', ${JSON.stringify([1, 0, 0])}::vector, to_tsvector('english', 'User prefers light mode'))
    `;
  });

  it("system prompt does NOT contain memories when memory flag is off", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("Hello there!");

    const { context } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "What are my preferences?" }],
    });
    await handleMessage(context);

    const llmRequest = mockServer.getRequests()[reqsBefore];
    const systemMsg = llmRequest.messages.find(m => m.role === "system");
    assert.ok(systemMsg, "Should have a system message");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(
      !systemText.includes("## Relevant memories"),
      "System prompt should NOT contain memory section when memory is disabled",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Memories NOT searched for short extracted text
// ═══════════════════════════════════════════════════════════════════
describe("Memory: NOT searched when extracted text < 10 chars", () => {
  const chatId = "mem-short-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET memory = true, memory_threshold = -2 WHERE chat_id = ${chatId}`;
    await testDb.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, 'User likes brevity', ${JSON.stringify([1, 0, 0])}::vector, to_tsvector('english', 'User likes brevity'))
    `;
  });

  it("system prompt does NOT contain memories for image-only message (no text to search)", async () => {
    // Image-only messages have no text content, so extractTextFromMessage returns ""
    // which is < 10 chars — memory search is skipped
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("I see an image!");

    const { context } = createIncomingContext({
      chatId,
      content: [{ type: "image", encoding: "base64", mime_type: "image/jpeg", data: "aGVsbG8=" }],
    });
    await handleMessage(context);

    const llmRequest = mockServer.getRequests()[reqsBefore];
    const systemMsg = llmRequest.messages.find(m => m.role === "system");
    assert.ok(systemMsg, "Should have a system message");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(
      !systemText.includes("## Relevant memories"),
      "System prompt should NOT contain memory section when extracted text is too short",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Tool error → LLM self-correction
// ═══════════════════════════════════════════════════════════════════
describe("Tool error → LLM self-correction", () => {
  const chatId = "tool-error-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("catches tool error, shows ❌, passes error to LLM, and delivers corrected reply", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_bad_001",
            type: "function",
            function: {
              name: "nonexistent_action_xyz",
              arguments: "{}",
            },
          },
        ],
      },
      "I apologize, let me try a different approach.",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Do something" }],
    });
    await handleMessage(context);

    // Should show error indicator to user
    assert.ok(
      responses.some(r => r.text.includes("❌")),
      `Should show ❌ error indicator, got: ${responses.map(r => r.text).join(" | ")}`,
    );

    // Second LLM request should contain a tool role message with the error
    const secondReq = mockServer.getRequests()[reqsBefore + 1];
    assert.ok(secondReq, "Should have a second LLM request for self-correction");
    const toolMsg = secondReq.messages.find(m => m.role === "tool");
    assert.ok(toolMsg, "Second request should have a tool message with error");
    const toolContent = typeof toolMsg.content === "string"
      ? toolMsg.content
      : JSON.stringify(toolMsg.content);
    assert.ok(
      toolContent.includes("Error") && toolContent.includes("nonexistent_action_xyz"),
      `Tool error message should mention the action, got: ${toolContent}`,
    );

    // Final text reply should be delivered
    assert.ok(
      responses.some(r => r.text.includes("different approach")),
      "Should deliver the corrected LLM reply",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: _media_refs resolution in tool calls
// ═══════════════════════════════════════════════════════════════════
describe("_media_refs resolution in tool calls", () => {
  const chatId = "media-refs-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
    // mock-model must support images so they pass through to formatMessagesForOpenAI
    // (otherwise convertUnsupportedMedia strips them before mediaRegistry is populated)
    await fs.writeFile(CACHE_PATH, JSON.stringify([
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
      { id: "mock-model", architecture: { input_modalities: ["text", "image"] } },
    ]));
  });

  after(async () => {
    // Restore original models cache
    await fs.writeFile(CACHE_PATH, JSON.stringify([
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
    ]));
  });

  it("injects _media_refs schema when media is present and resolves refs in tool calls", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_mref_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({
                code: "({content}) => `media_count:${content.filter(b => b.type === 'image').length}`",
                _media_refs: [1],
              }),
            },
          },
        ],
      },
      "The image was processed.",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [
        { type: "image", encoding: "base64", mime_type: "image/png", data: "iVBOR" },
        { type: "text", text: "Process this image" },
      ],
    });
    await handleMessage(context);

    // Tool schema should include _media_refs property
    const firstReq = mockServer.getRequests()[reqsBefore];
    assert.ok(firstReq, "Should have an LLM request");
    const tools = firstReq.tools || [];
    const jsToolSchema = tools.find(t => t.function?.name === "run_javascript");
    assert.ok(jsToolSchema, "Should have run_javascript in tools");
    assert.ok(
      jsToolSchema.function.parameters?.properties?._media_refs,
      "Tool schema should include _media_refs when media is present",
    );

    // System prompt should mention media tagging
    const systemMsg = firstReq.messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(
      systemText.includes("Media in the conversation is tagged"),
      "System prompt should mention media tagging",
    );

    // Tool result should reflect media was received (the code counts image blocks in context)
    const toolResultResp = responses.find(r => r.text.includes("media_count:"));
    assert.ok(
      toolResultResp,
      `Tool result should show media_count, got: ${responses.map(r => r.text).join(" | ")}`,
    );

    // Final reply delivered
    assert.ok(
      responses.some(r => r.text.includes("image was processed")),
      "Should deliver final reply",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Group chat system prompt suffix
// ═══════════════════════════════════════════════════════════════════
describe("Group chat system prompt suffix", () => {
  const chatId = "group-prompt-chat@g.us";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("appends 'You are in a group chat' to system prompt for group messages", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("Hello group!");

    const { context } = createIncomingContext({
      chatId,
      isGroup: true,
      content: [{ type: "text", text: "@bot-123 hello" }],
    });
    await handleMessage(context);

    const llmRequest = mockServer.getRequests()[reqsBefore];
    const systemMsg = llmRequest.messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(
      systemText.includes("You are in a group chat"),
      `System prompt should contain group chat suffix, got: ${systemText.slice(-100)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Quote blocks in LLM context
// ═══════════════════════════════════════════════════════════════════
describe("Quote blocks in LLM context", () => {
  const chatId = "quote-block-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("formats quoted text with '> ' prefix in LLM request", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("I see the quoted text.");

    const { context } = createIncomingContext({
      chatId,
      content: [
        { type: "quote", content: [{ type: "text", text: "Original quoted message" }] },
        { type: "text", text: "What about this?" },
      ],
    });
    await handleMessage(context);

    const llmRequest = mockServer.getRequests()[reqsBefore];
    const userMsg = llmRequest.messages.find(m => m.role === "user");
    assert.ok(userMsg, "Should have a user message");
    const userContent = JSON.stringify(userMsg.content);
    assert.ok(
      userContent.includes("> Original quoted message"),
      `User message should contain '> ' prefixed quoted text, got: ${userContent}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: enabled_actions filtering for LLM tool calls
// ═══════════════════════════════════════════════════════════════════
describe("enabled_actions filtering for LLM tool calls", () => {
  const chatWithout = "ea-without-chat";
  const chatWith = "ea-with-chat";

  before(async () => {
    await seedChat(chatWithout, { enabled: true });
    await seedChat(chatWith, { enabled: true });
    await testDb.sql`UPDATE chats SET enabled_actions = '["track_purchases"]'::jsonb WHERE chat_id = ${chatWith}`;
  });

  it("LLM tools list excludes opt-in actions unless enabled", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("No tracking here.");
    mockServer.addResponses("Tracking enabled!");

    const { context: ctx1 } = createIncomingContext({
      chatId: chatWithout,
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(ctx1);

    const { context: ctx2 } = createIncomingContext({
      chatId: chatWith,
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(ctx2);

    const req1 = mockServer.getRequests()[reqsBefore];
    const req2 = mockServer.getRequests()[reqsBefore + 1];

    const toolNames1 = (req1.tools || []).map(t => t.function?.name);
    const toolNames2 = (req2.tools || []).map(t => t.function?.name);

    assert.ok(
      !toolNames1.includes("track_purchases"),
      `Chat without enabled_actions should NOT have track_purchases in tools, got: ${toolNames1.join(", ")}`,
    );
    assert.ok(
      toolNames2.includes("track_purchases"),
      `Chat with enabled_actions should have track_purchases in tools, got: ${toolNames2.join(", ")}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: memory_threshold filters low-relevance memories
// ═══════════════════════════════════════════════════════════════════
describe("memory_threshold filters low-relevance memories", () => {
  const chatId = "mem-threshold-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET memory = true, memory_threshold = 0.99 WHERE chat_id = ${chatId}`;
    // Pre-insert a memory with a fixed embedding
    await testDb.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, 'User loves hiking', ${JSON.stringify([1, 0, 0])}::vector, to_tsvector('english', 'User loves hiking'))
    `;
  });

  it("system prompt does NOT contain memories when similarity is below threshold", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("I have no relevant memories.");

    const { context } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Tell me about my hobbies please" }],
    });
    await handleMessage(context);

    const llmRequest = mockServer.getRequests()[reqsBefore];
    const systemMsg = llmRequest.messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(
      !systemText.includes("## Relevant memories"),
      "System prompt should NOT contain memories when threshold filters them out",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Mixed autoContinue tool calls
// ═══════════════════════════════════════════════════════════════════
describe("Mixed autoContinue tool calls", () => {
  const chatId = "mixed-autocont-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("auto-continues when any tool call has autoContinue, no confirm prompt", async () => {
    const reqsBefore = mockServer.getRequests().length;
    // run_javascript has autoContinue:true, chat_settings does not
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_mix_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'mixed-result'" }),
            },
          },
          {
            id: "call_mix_002",
            type: "function",
            function: {
              name: "chat_settings",
              arguments: JSON.stringify({ setting: "" }),
            },
          },
        ],
      },
      "Mixed result complete.",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Run mixed tools" }],
    });
    await handleMessage(context);

    // No confirm prompt should have been shown
    assert.ok(
      !responses.some(r => r.type === "confirm"),
      `Should not ask for confirmation when any tool has autoContinue, got: ${responses.filter(r => r.type === "confirm").map(r => r.text).join(" | ")}`,
    );

    // Should have exactly 2 LLM requests (initial + continuation)
    const reqsAfter = mockServer.getRequests().length;
    assert.equal(
      reqsAfter - reqsBefore, 2,
      `Should have 2 LLM requests, got ${reqsAfter - reqsBefore}`,
    );

    // Final reply delivered
    assert.ok(
      responses.some(r => r.text.includes("Mixed result complete")),
      "Should deliver final LLM reply",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Action instructions injection
// ═══════════════════════════════════════════════════════════════════
describe("Action instructions injection", () => {
  const chatId = "action-instr-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("injects action instructions after first use, includes only once in subsequent calls", async () => {
    const reqsBefore = mockServer.getRequests().length;
    // 3 LLM responses: tool call, tool call, text reply
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_instr_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'step1'" }),
            },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: "call_instr_002",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'step2'" }),
            },
          },
        ],
      },
      "All steps complete.",
    );

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Run two steps" }],
    });
    await handleMessage(context);

    const reqs = mockServer.getRequests().slice(reqsBefore);
    assert.equal(reqs.length, 3, `Should have 3 LLM requests, got ${reqs.length}`);

    // Extract system prompts
    const getSystemText = (req) => {
      const sysMsg = req.messages.find(m => m.role === "system");
      return Array.isArray(sysMsg.content)
        ? sysMsg.content.map(c => c.text).join("")
        : sysMsg.content;
    };

    const sys1 = getSystemText(reqs[0]);
    const sys2 = getSystemText(reqs[1]);
    const sys3 = getSystemText(reqs[2]);

    // First request should NOT have instructions (not yet used)
    assert.ok(
      !sys1.includes("## run_javascript instructions"),
      "First request should not have run_javascript instructions",
    );

    // Second request should have instructions (injected after first use)
    assert.ok(
      sys2.includes("## run_javascript instructions"),
      "Second request should have run_javascript instructions",
    );

    // Third request should still have them but only ONE occurrence
    assert.ok(
      sys3.includes("## run_javascript instructions"),
      "Third request should still have run_javascript instructions",
    );
    const occurrences = sys3.split("## run_javascript instructions").length - 1;
    assert.equal(
      occurrences, 1,
      `Should have exactly 1 occurrence of instructions, got ${occurrences}`,
    );

    // Final reply delivered
    assert.ok(
      responses.some(r => r.text.includes("All steps complete")),
      "Should deliver final reply",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: storeLlmContext only at depth 0
// ═══════════════════════════════════════════════════════════════════
describe("storeLlmContext only at depth 0", () => {
  const chatId = "ctx-depth-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("stores llm_context for depth-0 assistant message but not for depth-1", async () => {
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_ctx_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => 'depth-test'" }),
            },
          },
        ],
      },
      "Depth test complete.",
    );

    const { context } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Test depth context" }],
    });
    await handleMessage(context);

    // storeLlmContext is fire-and-forget, give it time to flush
    await new Promise(r => setTimeout(r, 50));

    // Query assistant messages for this chat
    const { rows } = await testDb.sql`
      SELECT message_data, llm_context
      FROM messages
      WHERE chat_id = ${chatId}
        AND message_data->>'role' = 'assistant'
      ORDER BY message_id ASC
    `;

    assert.ok(rows.length >= 2, `Should have at least 2 assistant messages, got ${rows.length}`);

    // First assistant message (depth 0, has tool_calls) should have llm_context
    assert.ok(
      rows[0].llm_context !== null,
      "First assistant message (depth 0) should have llm_context",
    );

    // Second assistant message (depth 1, text reply) should NOT have llm_context
    assert.ok(
      rows[rows.length - 1].llm_context === null,
      "Last assistant message (depth > 0) should NOT have llm_context",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Presence updates (composing / paused)
// ═══════════════════════════════════════════════════════════════════
describe("Presence updates", () => {
  const chatId = "presence-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
  });

  it("sends composing before LLM and paused after", async () => {
    mockServer.addResponses("Presence test reply.");

    const { context, responses } = createIncomingContext({
      chatId,
      content: [{ type: "text", text: "Check presence" }],
    });
    await handleMessage(context);

    const presenceUpdates = responses.filter(r => r.type === "sendPresenceUpdate");
    assert.ok(
      presenceUpdates.some(r => r.text === "composing"),
      `Should send composing presence update, got: ${presenceUpdates.map(r => r.text).join(", ")}`,
    );
    assert.ok(
      presenceUpdates.some(r => r.text === "paused"),
      `Should send paused presence update, got: ${presenceUpdates.map(r => r.text).join(", ")}`,
    );

    // composing should come before the reply, paused should come after
    const composingIdx = responses.findIndex(r => r.type === "sendPresenceUpdate" && r.text === "composing");
    const replyIdx = responses.findIndex(r => r.text.includes("Presence test reply"));
    const pausedIdx = responses.findIndex(r => r.type === "sendPresenceUpdate" && r.text === "paused");

    assert.ok(composingIdx < replyIdx, "composing should come before reply");
    assert.ok(pausedIdx > replyIdx, "paused should come after reply");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: convertUnsupportedMedia warning for video
// ═══════════════════════════════════════════════════════════════════
describe("convertUnsupportedMedia warning", () => {
  const chatId = "unsupported-video-chat";
  /** @type {string} */
  let savedVideoModel;
  /** @type {string} */
  let savedMediaModel;

  before(async () => {
    await seedChat(chatId, { enabled: true });
    // Ensure no video_to_text_model / media_to_text_model is configured
    // (they may be set via .env), so video gets replaced with placeholder
    savedVideoModel = config.video_to_text_model;
    savedMediaModel = config.media_to_text_model;
    config.video_to_text_model = "";
    config.media_to_text_model = "";
  });

  after(() => {
    config.video_to_text_model = savedVideoModel;
    config.media_to_text_model = savedMediaModel;
  });

  it("shows ⚠️ warning and replaces video with placeholder text", async () => {
    const reqsBefore = mockServer.getRequests().length;
    mockServer.addResponses("I see you tried to send a video.");

    const { context, responses } = createIncomingContext({
      chatId,
      content: [
        { type: "video", encoding: "base64", mime_type: "video/mp4", data: "AAAA" },
        { type: "text", text: "Check this video" },
      ],
    });
    await handleMessage(context);

    // Should show ⚠️ warning about unsupported video
    assert.ok(
      responses.some(r => r.text.includes("⚠️") && r.text.includes("video")),
      `Should show ⚠️ warning about video, got: ${responses.map(r => r.text).join(" | ")}`,
    );

    // LLM request should have the placeholder text instead of video
    const llmRequest = mockServer.getRequests()[reqsBefore];
    const userMsg = llmRequest.messages.find(m => m.role === "user");
    const userContent = JSON.stringify(userMsg.content);
    assert.ok(
      userContent.includes("[Unsupported video"),
      `LLM request should contain placeholder text, got: ${userContent.slice(0, 300)}`,
    );

    // Final reply delivered
    assert.ok(
      responses.some(r => r.text.includes("tried to send a video")),
      "Should deliver final LLM reply",
    );
  });
});

}); // end describe("e2e")
