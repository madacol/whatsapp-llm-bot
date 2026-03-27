process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createChatTurn,
  createMockLlmServer,
  createTestDb,
  createTestHarness,
  toolCall,
  seedChat as seedChat_,
} from "./helpers.js";
import { setDb } from "../db.js";
import { startHtmlServer, stopHtmlServer } from "../html-server.js";
import config from "../config.js";

/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;
/** @type {import("@electric-sql/pglite").PGlite} */
let testDb;

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(testDb, chatId, options);

// ── All tests run serially to prevent concurrent mock-server races ──

describe("integration", { concurrency: 1 }, () => {

const CACHE_PATH = path.resolve("data/models.json");
const CODEX_CACHE_PATH = path.resolve("data/codex-models.json");

before(async () => {
  // 0. Seed models cache so setModel validation passes
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify([
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
  ]));
  await fs.writeFile(CODEX_CACHE_PATH, JSON.stringify({
    checkedAt: new Date().toISOString(),
    models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
  }));

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
  t = createTestHarness({ mockServer, handleMessage, testDb });
});

/** @type {ReturnType<typeof createTestHarness>} */
let t;

after(async () => {
  await mockServer?.close();
  await fs.rm(CACHE_PATH, { force: true });
  await fs.rm(CODEX_CACHE_PATH, { force: true });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 0: createChatTurn provides the normalized turn capabilities
// ═══════════════════════════════════════════════════════════════════
describe("createChatTurn shape", () => {
  it("includes react, select, and confirm in io", () => {
    const { context } = createChatTurn();
    assert.equal(typeof context.io.react, "function", "should have io.react");
    assert.equal(typeof context.io.select, "function", "should have io.select");
    assert.equal(typeof context.io.confirm, "function", "should have io.confirm");
  });

  it("io.react records response", async () => {
    const { context, responses } = createChatTurn();
    await context.io.react("👍");
    assert.ok(responses.some(r => r.type === "reactToMessage" && r.text === "👍"));
  });

  it("io.select records response and returns empty string", async () => {
    const { context, responses } = createChatTurn();
    const result = await context.io.select("Vote", ["A", "B"]);
    assert.equal(result, "");
    assert.ok(responses.some(r => r.type === "select"));
  });

  it("io.confirm records response and returns true by default", async () => {
    const { context, responses } = createChatTurn();
    const result = await context.io.confirm("Are you sure?");
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

  it("master user enables chat with !c enabled on", async () => {
    const chat = await t.chat(chatId);
    const r = await chat.send("!c enabled on");
    assert.ok(r.raw.length > 0, "Bot should respond");
    assert.ok(r.raw.some(x => x.text.toLowerCase().includes("enabled")), "Should confirm enabling");
  });

  it("bot responds via LLM to a text message in an enabled chat", async () => {
    const chat = await t.chat(chatId);
    const r = await chat.send("Hey there", { llm: ["Hello from the LLM!"] });
    assert.ok(r.raw.length > 0, "Bot should respond");
    assert.ok(r.raw.some(x => x.text.includes("Hello from the LLM!")), "Response should include LLM output");
  });

  it("master user disables chat with !c enabled off", async () => {
    const chat = await t.chat(chatId);
    const r = await chat.send("!c enabled off");
    assert.ok(r.raw.length > 0, "Bot should respond");
    assert.ok(r.raw.some(x => x.text.toLowerCase().includes("disabled")), "Should confirm disabling");
  });

  it("bot does NOT respond to messages in a disabled chat", async () => {
    const chat = await t.chat(chatId);
    const r = await chat.send("Hello?");
    assert.equal(r.raw.length, 0, "Bot should not respond when disabled");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 2: Non-master cannot enable / disable
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 2: Non-master cannot enable/disable", () => {
  it("rejects !c enabled from non-master user", async () => {
    const chat = await t.chat("s2-chat");
    const r = await chat.send("!c enabled on", { sender: { id: "non-master-user" } });
    assert.ok(r.raw.length > 0, "Bot should respond with error");
    assert.ok(r.raw.some(x => x.text.toLowerCase().includes("master")), "Should mention master permissions");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 3: Unknown command
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 3: Unknown command", () => {
  it("responds with error for unknown command", async () => {
    const chat = await t.chat("s3-chat");
    const r = await chat.send("!foobar");
    assert.ok(r.raw.length > 0, "Bot should respond");
    assert.ok(r.raw.some(x => x.text.toLowerCase().includes("unknown command")), "Should mention unknown command");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 4: Set and get system prompt
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 4: Set and get system prompt", () => {
  it("sets and retrieves prompt help with !c prompt", async () => {
    const chat = await t.chat("s4-chat", { enabled: true });

    const r1 = await chat.send("!c prompt pirate");
    assert.ok(r1.raw.some(x => x.text.includes("pirate")), "Should confirm prompt containing 'pirate'");

    const r2 = await chat.send("!c prompt");
    assert.ok(r2.raw.some(x => x.text.includes("pirate")), "Should return prompt containing 'pirate'");
    assert.ok(r2.raw.some(x => x.text.toLowerCase().includes("what it does")), "Should include help text");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 5: Set and get model
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 5: Set and get model", () => {
  before(async () => {
    // Re-seed models cache (may have been deleted by action-test-functions)
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify([
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
    ]));
  });

  it("sets and retrieves model with !c model", async () => {
    const chat = await t.chat("s5-chat", { enabled: true });

    const r1 = await chat.send("!c model gpt-4.1-mini");
    assert.ok(r1.raw.some(x => x.text.includes("Model set to")),
      `Should confirm model was set, got: ${JSON.stringify(r1.raw.map(x => x.text))}`);

    const r2 = await chat.send("!c");
    assert.ok(r2.raw.some(x => x.text.includes("gpt-4.1-mini")), "Should return model name in info output");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 6: New conversation clears history
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 6: New conversation clears history", () => {
  it("after !clear the next LLM call sees only the new message", async () => {
    const chat = await t.chat("s6-chat", { enabled: true });

    await chat.send("Remember this", { llm: ["First response"] });
    const r2 = await chat.send("!clear");
    assert.ok(r2.raw.some(x => x.text.toLowerCase().includes("clear")), "Should confirm clearing");

    const r3 = await chat.send("Fresh start", { llm: ["Second response"] });
    assert.ok(r3.raw.some(x => x.text.includes("Second response")));
    const userMessages = r3.requests[0].messages.filter(m => m.role === "user");
    assert.equal(userMessages.length, 1, "LLM should see only 1 user message after history clear");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 7: Show info
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 7: Show info", () => {
  it("!c shows chat ID, enabled status, and sender info", async () => {
    const chatId = "s7-chat";
    const chat = await t.chat(chatId, { enabled: true });
    const r = await chat.send("!c");
    const allText = r.raw.map(x => x.text).join(" ");
    assert.ok(allText.includes(chatId), "Should contain chat ID");
    assert.ok(allText.toLowerCase().includes("enabled"), "Should contain enabled status");
    assert.ok(allText.toLowerCase().includes("sender"), "Should contain sender info");
  });

  it("resets folder with !c reset folder", async () => {
    const chatId = "s7-folder";
    const chat = await t.chat(chatId, { enabled: true });

    const r1 = await chat.send("!c folder /tmp");
    assert.ok(r1.raw.some(x => x.text.includes("/tmp")), `Should confirm folder was set, got: ${JSON.stringify(r1.raw.map(x => x.text))}`);

    const r2 = await chat.send("!c reset folder");
    assert.ok(r2.raw.some(x => x.text.toLowerCase().includes("workspace") || x.text.toLowerCase().includes("default")),
      `Should confirm folder reset, got: ${JSON.stringify(r2.raw.map(x => x.text))}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 7b: Guided setup command
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 7b: Guided setup command", () => {
  it("applies the basic chat configuration through !setup", async () => {
    const chatId = "s7b-chat";
    await seedChat(chatId);

    /** @type {string[]} */
    const selections = ["mention+reply", "codex", "gpt-5.4", "off"];
    /** @type {string[]} */
    const questions = [];
    const { context, responses } = createChatTurn({
      chatId,
      content: [{ type: "text", text: "!setup" }],
    });
    context.io.select = async (question, options) => {
      questions.push(question);
      responses.push({ type: "select", text: JSON.stringify({ question, options }) });
      return selections.shift() ?? "";
    };

    await handleMessage(context);

    const allText = responses.map((entry) => entry.text).join(" ");
    assert.equal(questions[0], "When should the bot reply in group chats?");
    assert.ok(!questions.includes("Enable the bot for this chat?"), `Enable prompt should be skipped, got: ${questions.join(" | ")}`);
    assert.ok(allText.toLowerCase().includes("enabled"), `Expected enabled summary, got: ${allText}`);
    assert.ok(allText.includes("mention+reply"), `Expected trigger summary, got: ${allText}`);
    assert.ok(allText.includes("codex"), `Expected harness summary, got: ${allText}`);
    assert.ok(allText.includes("gpt-5.4"), `Expected harness model summary, got: ${allText}`);

    const { rows: [chat] } = await testDb.sql`
      SELECT is_enabled, respond_on, memory, debug, harness, harness_config
      FROM chats
      WHERE chat_id = ${chatId}
    `;
    assert.equal(chat.is_enabled, true);
    assert.equal(chat.respond_on, "mention+reply");
    assert.equal(chat.memory, false);
    assert.equal(chat.debug, false);
    assert.equal(chat.harness, "codex");
    assert.equal(chat.harness_config.codex.model, "gpt-5.4");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 8: Run JavaScript via LLM tool call
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 8: Run JavaScript via tool call", () => {
  it("executes run_javascript tool call and returns final LLM reply", async () => {
    const chatId = "s8-chat";
    const chat = await t.chat(chatId, { enabled: true, debug: true });

    const r = await chat.send("What is the chat ID?", {
      llm: [toolCall("run_javascript", { code: "({chatId}) => chatId" }), `The chat ID is ${chatId}`],
    });

    assert.ok(r.raw.length >= 3, `Expected >= 3 responses, got ${r.raw.length}`);
    assert.ok(r.raw.some(x => x.text.includes("run_javascript")), "Should show tool execution notification");
    assert.ok(r.raw.some(x => x.text.includes(chatId)), "Tool result should contain the chat ID");
    assert.ok(r.raw.some(x => x.text.includes(`The chat ID is ${chatId}`)), "Final reply should contain result");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 8b: Tool call depth guard
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 8b: Tool call depth guard", () => {
  const chatId = "s8b-chat";

  after(() => {
    assert.equal(
      mockServer.pendingResponses(),
      0,
      `Scenario 8b leaked ${mockServer.pendingResponses()} unconsumed mock responses`,
    );
  });

  it("offers confirmation at depth limit; stops when user declines", async () => {
    const toolCalls = Array.from({ length: 15 }, (_, i) =>
      toolCall(`nonexistent_action_for_depth_test_${i}`, {}),
    );

    const chat = await t.chat(chatId, { enabled: true });
    const r = await chat.send("trigger depth test", {
      llm: toolCalls,
      confirm: false,
    });

    assert.ok(r.requests.length <= 11,
      `Expected at most 11 LLM requests (depth guard at 10), got ${r.requests.length}`);
    assert.ok(r.confirms.length > 0, "Should ask user for confirmation at depth limit");
    assert.ok(
      r.confirms[0].toLowerCase().includes("depth") || r.confirms[0].toLowerCase().includes("limit"),
      "Confirm message should mention depth/limit",
    );
  });

  it("continues processing when user confirms at depth limit", async () => {
    let confirmCount = 0;
    const toolCalls = Array.from({ length: 25 }, (_, i) =>
      toolCall(`nonexistent_action_for_cont_test_${i}`, {}),
    );

    const chat = await t.chat(chatId, { enabled: true });
    const r = await chat.send("trigger continuation test", {
      llm: [...toolCalls, "Done!"],
      confirm: () => ++confirmCount <= 1,
    });

    // First cycle: 11 requests (1 initial + 10 continuations)
    // User confirms → second cycle starts, another 10 continuations
    // User declines at second limit → stops
    assert.ok(r.requests.length > 11,
      `Expected more than 11 requests after user confirmed continuation, got ${r.requests.length}`);
    assert.ok(r.requests.length <= 22,
      `Expected at most 22 requests (two depth cycles + decline), got ${r.requests.length}`);
    assert.equal(r.confirms.length, 2, "Should ask user twice (confirm once, decline once)");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 9: Group chat — only responds when mentioned
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 9: Group chat — only responds when mentioned", () => {
  it("does NOT respond in group when bot is not mentioned", async () => {
    const chat = await t.chat("s9-chat@g.us", { enabled: true });
    const r = await chat.send("Hello everyone", { isGroup: true });
    assert.equal(r.raw.length, 0, "Should not respond when not mentioned");
  });

  it("responds in group when bot is @mentioned", async () => {
    const chat = await t.chat("s9-chat@g.us", { enabled: true });
    const r = await chat.send("@bot-123 what's up?", { isGroup: true, llm: ["Hi from the bot!"] });
    assert.ok(r.raw.length > 0, "Should respond when mentioned");
    assert.ok(r.raw.some(x => x.text.includes("Hi from the bot!")));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 10: Private chat — always responds when enabled
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 10: Private chat — always responds when enabled", () => {
  it("responds to any text in an enabled private chat", async () => {
    const chat = await t.chat("s10-chat", { enabled: true });
    const r = await chat.send("Hi", { llm: ["Private chat response"] });
    assert.ok(r.raw.length > 0);
    assert.ok(r.raw.some(x => x.text.includes("Private chat response")));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 11: Group — stores messages even when bot doesn't respond
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 11: Group stores messages even when not responding", () => {
  it("stores a non-triggering message so it appears in later history", async () => {
    const chat = await t.chat("s11-chat@g.us", { enabled: true });

    // Send a message without mentioning the bot — bot should NOT respond
    const r1 = await chat.send("Hey guys, check this out", {
      sender: { name: "Alice" },
      isGroup: true,
    });
    assert.equal(r1.raw.length, 0, "Bot should not respond when not mentioned");

    // Now mention the bot — it should respond, and the previous message should be in history
    const r2 = await chat.send("@bot-123 what did Alice say?", {
      isGroup: true,
      llm: ["I can see Alice said something earlier!"],
    });
    assert.ok(r2.raw.length > 0, "Bot should respond when mentioned");

    // Verify the first message was stored by checking the LLM request
    const allContent = JSON.stringify(r2.requests[0].messages);
    assert.ok(
      allContent.includes("Hey guys, check this out"),
      `Previous non-triggered message should be in history, got: ${allContent.slice(0, 500)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 12: Tool call display — always verbose
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 12: Tool call display is always verbose", () => {
  it("shows bold tool name with args even without debug mode", async () => {
    const chat = await t.chat("s12-verbose", { enabled: true });
    const r = await chat.send("Test verbose", {
      llm: [toolCall("run_javascript", { code: "() => 'hello'" }), "Final answer"],
    });

    assert.ok(r.raw.some(x => x.text.includes("Final answer")), "Should have the final LLM reply");
    assert.ok(r.raw.some(x => x.source === "tool-call" && x.text.includes("*run_javascript*")),
      `Should show bold tool name, got: ${r.raw.map(x=>x.text).join(" | ")}`);
  });

  it("shows formatted tool call from actionFormatter", async () => {
    const chat = await t.chat("s12-verbose", { enabled: true });
    const r = await chat.send("Show settings", {
      llm: [toolCall("chat_settings", { setting: "model" })],
    });

    assert.ok(r.raw.some(x => x.source === "tool-call" && x.text.includes("chat_settings")),
      `Should show tool call, got: ${r.raw.map(x=>x.text).join(" | ")}`);
  });

  it("shows usage info without requiring debug mode", async () => {
    const chat = await t.chat("s12-usage", { enabled: true });
    const r = await chat.send("Test usage", {
      llm: "Simple answer",
    });

    assert.ok(r.raw.some(x => x.source === "usage"),
      `Should show usage info, got: ${r.raw.map(x => `${x.source}:${x.text}`).join(" | ")}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 11: Adapter — getMessageContent extraction
// ═══════════════════════════════════════════════════════════════════
describe("Scenario 11: getMessageContent extraction", () => {
  /** @type {typeof import("../whatsapp/inbound/message-content.js").getMessageContent} */
  let getMessageContent;

  before(async () => {
    ({ getMessageContent } = await import("../whatsapp/inbound/message-content.js"));
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
  it("opt-in action command fails when not enabled for chat", async () => {
    const chat = await t.chat("opt-in-chat", { enabled: true });
    const r = await chat.send("!compras history");
    assert.ok(r.raw.some(x => x.text.toLowerCase().includes("unknown command")),
      `Should reject opt-in command, got: ${JSON.stringify(r.raw.map(x => x.text))}`);
  });

  it("opt-in action works after enabling it", async () => {
    const chat = await t.chat("opt-in-chat", { enabled: true, enabledActions: ["track_purchases"] });
    const r = await chat.send("!compras history");
    assert.ok(!r.raw.some(x => x.text.toLowerCase().includes("unknown command")),
      `Should recognize opt-in command after enabling, got: ${JSON.stringify(r.raw.map(x => x.text))}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: HtmlContent from LLM tool call sends link URL
// ═══════════════════════════════════════════════════════════════════
describe("HtmlContent via LLM tool call", () => {
  /** @type {number} */
  let htmlPort;

  before(async () => {
    htmlPort = await startHtmlServer(0, testDb);
    process.env.HTML_SERVER_BASE_URL = `http://127.0.0.1:${htmlPort}`;
  });

  after(async () => {
    await stopHtmlServer();
    delete process.env.HTML_SERVER_BASE_URL;
  });

  it("sends link URL to user when tool returns HtmlContent", async () => {
    const chat = await t.chat("html-tool-chat", { enabled: true, debug: true });
    const r = await chat.send("Generate a report", {
      llm: [
        toolCall("run_javascript", { code: '() => ({ __brand: "html", html: "<h1>Report</h1>", title: "Sales Report" })' }),
        "Here is your report!",
      ],
    });

    // Link appears as an edit on the tool-call message (edit-in-place)
    const linkResponse = r.raw.find(x => x.text.includes("/page/"));
    assert.ok(linkResponse, `Should have a page link (via edit or send), got: ${r.raw.map(x => x.text).join(" | ")}`);
    assert.ok(linkResponse.text.includes("Sales Report"), `Link text should include the title, got: ${linkResponse.text}`);

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
  /** @type {number} */
  let htmlPort;

  before(async () => {
    htmlPort = await startHtmlServer(0, testDb);
    process.env.HTML_SERVER_BASE_URL = `http://127.0.0.1:${htmlPort}`;
  });

  after(async () => {
    await stopHtmlServer();
    delete process.env.HTML_SERVER_BASE_URL;
  });

  it("sends link URL when !js returns HtmlContent", async () => {
    const chat = await t.chat("html-cmd-chat", { enabled: true });
    const r = await chat.send('!js () => ({ __brand: "html", html: "<p>Hello</p>", title: "Test" })');
    const linkResponse = r.raw.find(x => x.text.includes("/page/"));
    assert.ok(linkResponse, `Should send a page link, got: ${r.raw.map(x => x.text).join(" | ")}`);
    assert.ok(linkResponse.text.includes("Test"), `Link text should include the title, got: ${linkResponse.text}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Multi-turn conversation accumulates context
// ═══════════════════════════════════════════════════════════════════
describe("Multi-turn conversation accumulates context", () => {
  it("LLM sees all prior turns in context", async () => {
    const chat = await t.chat("multi-turn-chat", { enabled: true });

    await chat.send("My name is Alice", { llm: ["I'll remember that."] });
    await chat.send("I like cats", { llm: ["Got it, you like cats."] });
    const r = await chat.send("Summarize what you know about me", {
      llm: ["Sure, Alice who likes cats!"],
    });

    const allContent = JSON.stringify(r.requests[0].messages);
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
  it("converts image to text via media-to-text model, then sends text to main LLM", async () => {
    const chat = await t.chat("media-convert-chat", { enabled: true });
    const r = await chat.send(
      { image: "aGVsbG8=", mime: "image/jpeg", caption: "Describe this image" },
      { llm: ["A photo of a sunset over the ocean.", "Based on the image description, I can see a beautiful sunset!"] },
    );

    assert.ok(r.raw.some(x => x.text.includes("beautiful sunset")),
      `Should get LLM response, got: ${r.raw.map(x => `[${x.type}] ${x.text.slice(0, 80)}`).join(" | ")}`);
    assert.ok(r.requests.length >= 2, `Expected at least 2 LLM requests (convert + chat), got ${r.requests.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: LLM returns multiple tool calls in one turn
// ═══════════════════════════════════════════════════════════════════
describe("Multiple tool calls in a single LLM response", () => {
  it("executes all tool calls and sends results back to LLM", async () => {
    const chat = await t.chat("multi-tool-chat", { enabled: true });
    const r = await chat.send("Run two things at once", {
      llm: [
        { tool_calls: [
          { id: "call_multi_001", type: "function", function: { name: "run_javascript", arguments: JSON.stringify({ code: "() => 'result-A'" }) } },
          { id: "call_multi_002", type: "function", function: { name: "run_javascript", arguments: JSON.stringify({ code: "() => 'result-B'" }) } },
        ] },
        "Both tools returned results A and B.",
      ],
    });

    assert.ok(r.raw.some(x => x.text.includes("Both tools returned")), "Should get final LLM reply after both tools");
    const secondReq = /** @type {any} */ (r.requests[1]);
    const toolMsgs = secondReq.messages.filter(m => m.role === "tool");
    assert.equal(toolMsgs.length, 2, `Should have 2 tool result messages, got ${toolMsgs.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Error recovery across turns
// ═══════════════════════════════════════════════════════════════════
describe("Error recovery across turns", () => {
  it("bot recovers on next turn after LLM API error", async () => {
    const chat = await t.chat("error-recovery-chat", { enabled: true });

    // Turn 1 — no mock responses queued → server returns 500
    const r1 = await chat.send("First message");
    assert.ok(r1.raw.some(x => x.source === "error"), "Should show error to user");

    // Turn 2 — normal response
    const r2 = await chat.send("Try again", { llm: ["Back to normal!"] });
    assert.ok(r2.raw.some(x => x.text.includes("Back to normal")), "Should recover and respond normally on next turn");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Group respond_on modes
// ═══════════════════════════════════════════════════════════════════
describe("Group respond_on modes", () => {
  it("respond_on=any: responds to every message in group", async () => {
    const chat = await t.chat("respond-any@g.us", { enabled: true, respondOn: "any" });
    const r = await chat.send("Hello everyone", { isGroup: true, llm: ["Responding to everything!"] });
    assert.ok(r.raw.some(x => x.text.includes("Responding to everything")),
      "Should respond even without mention when respond_on=any");
  });

  it("respond_on=mention+reply: responds to reply-to-bot", async () => {
    const chat = await t.chat("respond-reply@g.us", { enabled: true, respondOn: "mention+reply" });
    const r = await chat.send("What did you mean?", {
      isGroup: true,
      quote: { text: "something", senderId: "bot-123" },
      llm: ["Replying to your reply!"],
    });
    assert.ok(r.raw.some(x => x.text.includes("Replying to your reply")),
      "Should respond when user replies to bot's message");
  });

  it("respond_on=mention+reply: ignores unrelated messages", async () => {
    const chat = await t.chat("respond-reply-ignore@g.us", { enabled: true, respondOn: "mention+reply" });
    const r = await chat.send("Just chatting", { isGroup: true });
    assert.equal(r.raw.length, 0, "Should not respond to unrelated message");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Confirmation declined stops action execution
// ═══════════════════════════════════════════════════════════════════
describe("Confirmation declined prevents action execution", () => {
  it("action is skipped when user declines confirmation", async () => {
    const chat = await t.chat("confirm-decline-chat", { enabled: true });
    const r = await chat.send("Run a shell command", {
      llm: [toolCall("run_bash", { command: "echo hello" }), "The command was not executed."],
      confirm: false,
    });

    assert.ok(r.confirms.length > 0, "Should ask for confirmation before running bash");
    assert.ok(r.raw.some(x => x.text.toLowerCase().includes("cancel") || x.text.toLowerCase().includes("denied")),
      `Should indicate action was cancelled, got: ${r.raw.map(x => x.text).join(" | ")}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: save_memory tool call stores memory in DB
// ═══════════════════════════════════════════════════════════════════
describe("Memory: save_memory tool call stores memory in DB", () => {
  it("saves memory via tool call and delivers final LLM reply", async () => {
    const chatId = "mem-save-chat";
    const chat = await t.chat(chatId, { enabled: true, memory: true });
    const r = await chat.send("I really love cats", {
      llm: [toolCall("save_memory", { content: "User likes cats" }), "Got it, I'll remember that!"],
    });

    const { rows } = await testDb.sql`SELECT * FROM memories WHERE chat_id = ${chatId}`;
    assert.ok(rows.length > 0, "Memory should be stored in DB");
    assert.equal(rows[0].content, "User likes cats");
    assert.ok(r.raw.some(x => x.text.includes("Got it, I'll remember that!")),
      `Should deliver final LLM reply, got: ${r.raw.map(x => x.text).join(" | ")}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Saved memories are injected into the system prompt
// ═══════════════════════════════════════════════════════════════════
describe("Memory: injected into system prompt", () => {
  const chatId = "mem-inject-chat";

  before(async () => {
    // Pre-insert a memory with embedding so the vector similarity path finds it
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET memory = true, memory_threshold = -2 WHERE chat_id = ${chatId}`;
    await testDb.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, 'User prefers dark mode', ${JSON.stringify([1, 0, 0])}::vector, to_tsvector('english', 'User prefers dark mode'))
    `;
  });

  it("system prompt contains relevant memories for matching message", async () => {
    const chat = await t.chat(chatId);
    const r = await chat.send("What are my preferences?", { llm: ["Sure, I know your preferences!"] });

    const systemMsg = /** @type {any} */ (r.requests[0]).messages.find(m => m.role === "system");
    assert.ok(systemMsg, "Should have a system message");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(systemText.includes("## Relevant memories"),
      `System prompt should contain memory section, got: ${systemText.slice(-300)}`);
    assert.ok(systemText.includes("User prefers dark mode"),
      `System prompt should contain the memory content, got: ${systemText.slice(-300)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Memories NOT injected when memory is disabled
// ═══════════════════════════════════════════════════════════════════
describe("Memory: NOT injected when memory is disabled", () => {
  const chatId = "mem-disabled-chat";

  before(async () => {
    await seedChat(chatId, { enabled: true });
    await testDb.sql`UPDATE chats SET memory_threshold = -2 WHERE chat_id = ${chatId}`;
    await testDb.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, 'User prefers light mode', ${JSON.stringify([1, 0, 0])}::vector, to_tsvector('english', 'User prefers light mode'))
    `;
  });

  it("system prompt does NOT contain memories when memory flag is off", async () => {
    const chat = await t.chat(chatId);
    const r = await chat.send("What are my preferences?", { llm: ["Hello there!"] });

    const systemMsg = /** @type {any} */ (r.requests[0]).messages.find(m => m.role === "system");
    assert.ok(systemMsg, "Should have a system message");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(!systemText.includes("## Relevant memories"),
      "System prompt should NOT contain memory section when memory is disabled");
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
    const chat = await t.chat(chatId);
    const r = await chat.send(
      { image: "aGVsbG8=", mime: "image/jpeg" },
      { llm: ["I see an image!"] },
    );

    const systemMsg = /** @type {any} */ (r.requests[0]).messages.find(m => m.role === "system");
    assert.ok(systemMsg, "Should have a system message");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(!systemText.includes("## Relevant memories"),
      "System prompt should NOT contain memory section when extracted text is too short");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Tool error → LLM self-correction
// ═══════════════════════════════════════════════════════════════════
describe("Tool error → LLM self-correction", () => {
  it("catches tool error, shows ❌, passes error to LLM, and delivers corrected reply", async () => {
    const chat = await t.chat("tool-error-chat", { enabled: true });

    const r = await chat.send("Do something", {
      llm: [
        toolCall("nonexistent_action_xyz", {}),
        "I apologize, let me try a different approach.",
      ],
    });

    // Should show error indicator to user
    assert.ok(
      r.raw.some(x => x.source === "error"),
      `Should show error indicator, got: ${r.raw.map(x => x.text).join(" | ")}`,
    );

    // Second LLM request should contain a tool role message with the error
    const secondReq = /** @type {any} */ (r.requests[1]);
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
      r.raw.some(x => x.text.includes("different approach")),
      "Should deliver the corrected LLM reply",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: image param resolution in tool calls
// ═══════════════════════════════════════════════════════════════════
describe("image param resolution in tool calls", () => {
  before(async () => {
    // mock-model must support images so they pass through to formatMessagesForOpenAI
    await fs.writeFile(CACHE_PATH, JSON.stringify([
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
      { id: "mock-model", architecture: { input_modalities: ["text", "image"] } },
    ]));
  });

  after(async () => {
    await fs.writeFile(CACHE_PATH, JSON.stringify([
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000003" } },
    ]));
  });

  it("resolves image params from media file paths in tool calls", async () => {
    const chat = await t.chat("media-refs-chat", { enabled: true });
    const r = await chat.send(
      { image: "iVBOR", mime: "image/png", caption: "Process this image" },
      {
        llm: [
          { tool_calls: [{
            id: "call_mref_001", type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({
                code: "({content}) => `media_count:${content.filter(b => b.type === 'image').length}`",
              }),
            },
          }] },
          "The image was processed.",
        ],
      },
    );

    const firstReq = /** @type {any} */ (r.requests[0]);
    assert.ok(firstReq, "Should have an LLM request");

    const systemMsg = firstReq.messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(systemText.includes("canonical file paths"),
      "System prompt should mention media file paths");

    assert.ok(r.raw.some(x => x.text.includes("image was processed")), "Should deliver final reply");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Group chat system prompt suffix
// ═══════════════════════════════════════════════════════════════════
describe("Group chat system prompt suffix", () => {
  it("appends 'You are in a group chat' to system prompt for group messages", async () => {
    const chat = await t.chat("group-prompt-chat@g.us", { enabled: true });
    const r = await chat.send("@bot-123 hello", { isGroup: true, llm: ["Hello group!"] });

    const systemMsg = /** @type {any} */ (r.requests[0]).messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(systemText.includes("You are in a group chat"),
      `System prompt should contain group chat suffix, got: ${systemText.slice(-100)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Quote blocks in LLM context
// ═══════════════════════════════════════════════════════════════════
describe("Quote blocks in LLM context", () => {
  it("formats quoted text with '> ' prefix in LLM request", async () => {
    const chat = await t.chat("quote-block-chat", { enabled: true });
    const r = await chat.send("What about this?", {
      quote: { text: "Original quoted message" },
      llm: ["I see the quoted text."],
    });

    const userMsg = /** @type {any} */ (r.requests[0]).messages.find(m => m.role === "user");
    assert.ok(userMsg, "Should have a user message");
    const userContent = JSON.stringify(userMsg.content);
    assert.ok(userContent.includes("> Original quoted message"),
      `User message should contain '> ' prefixed quoted text, got: ${userContent}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: enabled_actions filtering for LLM tool calls
// ═══════════════════════════════════════════════════════════════════
describe("enabled_actions filtering for LLM tool calls", () => {
  it("LLM tools list excludes opt-in actions unless enabled", async () => {
    const chatWithout = await t.chat("ea-without-chat", { enabled: true });
    const chatWith = await t.chat("ea-with-chat", { enabled: true, enabledActions: ["track_purchases"] });

    const r1 = await chatWithout.send("Hello", { llm: ["No tracking here."] });
    const r2 = await chatWith.send("Hello", { llm: ["Tracking enabled!"] });

    const toolNames1 = (/** @type {any} */ (r1.requests[0]).tools || []).map(x => x.function?.name);
    const toolNames2 = (/** @type {any} */ (r2.requests[0]).tools || []).map(x => x.function?.name);

    assert.ok(!toolNames1.includes("track_purchases"),
      `Chat without enabled_actions should NOT have track_purchases, got: ${toolNames1.join(", ")}`);
    assert.ok(toolNames2.includes("track_purchases"),
      `Chat with enabled_actions should have track_purchases, got: ${toolNames2.join(", ")}`);
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
    await testDb.sql`
      INSERT INTO memories (chat_id, content, embedding, search_text)
      VALUES (${chatId}, 'User loves hiking', ${JSON.stringify([1, 0, 0])}::vector, to_tsvector('english', 'User loves hiking'))
    `;
  });

  it("system prompt does NOT contain memories when similarity is below threshold", async () => {
    const chat = await t.chat(chatId);
    const r = await chat.send("Tell me about my hobbies please", { llm: ["I have no relevant memories."] });

    const systemMsg = /** @type {any} */ (r.requests[0]).messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content)
      ? systemMsg.content.map(c => c.text).join("")
      : systemMsg.content;
    assert.ok(!systemText.includes("## Relevant memories"),
      "System prompt should NOT contain memories when threshold filters them out");
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

});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Action instructions injection
// ═══════════════════════════════════════════════════════════════════
describe("Action instructions injection", () => {
  it("injects action instructions after first use, includes only once in subsequent calls", async () => {
    const chat = await t.chat("action-instr-chat", { enabled: true });
    const r = await chat.send("Run two steps", {
      llm: [
        toolCall("run_javascript", { code: "() => 'step1'" }),
        toolCall("run_javascript", { code: "() => 'step2'" }),
        "All steps complete.",
      ],
    });

    assert.equal(r.requests.length, 3, `Should have 3 LLM requests, got ${r.requests.length}`);

    const getSystemText = (req) => {
      const sysMsg = /** @type {any} */ (req).messages.find(m => m.role === "system");
      return Array.isArray(sysMsg.content) ? sysMsg.content.map(c => c.text).join("") : sysMsg.content;
    };

    const sys1 = getSystemText(r.requests[0]);
    const sys2 = getSystemText(r.requests[1]);
    const sys3 = getSystemText(r.requests[2]);

    assert.ok(!sys1.includes("## run_javascript instructions"), "First request should not have instructions");
    assert.ok(sys2.includes("## run_javascript instructions"), "Second request should have instructions");
    assert.ok(sys3.includes("## run_javascript instructions"), "Third request should still have instructions");
    const occurrences = sys3.split("## run_javascript instructions").length - 1;
    assert.equal(occurrences, 1, `Should have exactly 1 occurrence, got ${occurrences}`);
    assert.ok(r.raw.some(x => x.text.includes("All steps complete")), "Should deliver final reply");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: storeLlmContext only at depth 0
// ═══════════════════════════════════════════════════════════════════
describe("storeLlmContext only at depth 0", () => {
  it("stores llm_context for depth-0 assistant message but not for depth-1", async () => {
    const chatId = "ctx-depth-chat";
    const chat = await t.chat(chatId, { enabled: true });
    await chat.send("Test depth context", {
      llm: [toolCall("run_javascript", { code: "() => 'depth-test'" }), "Depth test complete."],
    });

    // storeLlmContext is fire-and-forget, give it time to flush
    await new Promise(r => setTimeout(r, 50));

    const { rows } = await testDb.sql`
      SELECT message_data, llm_context
      FROM messages
      WHERE chat_id = ${chatId}
        AND message_data->>'role' = 'assistant'
      ORDER BY message_id ASC
    `;

    assert.ok(rows.length >= 2, `Should have at least 2 assistant messages, got ${rows.length}`);
    assert.ok(rows[0].llm_context !== null, "First assistant message (depth 0) should have llm_context");
    assert.ok(rows[rows.length - 1].llm_context === null, "Last assistant message (depth > 0) should NOT have llm_context");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: Presence updates (composing / paused)
// ═══════════════════════════════════════════════════════════════════
describe("Presence updates", () => {
  it("sends composing before LLM and paused after", async () => {
    const chat = await t.chat("presence-chat", { enabled: true });
    const r = await chat.send("Check presence", { llm: ["Presence test reply."] });

    assert.ok(r.presence.includes("composing"),
      `Should send composing presence update, got: ${r.presence.join(", ")}`);
    assert.ok(r.presence.includes("paused"),
      `Should send paused presence update, got: ${r.presence.join(", ")}`);

    const composingIdx = r.raw.findIndex(x => x.type === "sendPresenceUpdate" && x.text === "composing");
    const replyIdx = r.raw.findIndex(x => x.text.includes("Presence test reply"));
    const pausedIdx = r.raw.findIndex(x => x.type === "sendPresenceUpdate" && x.text === "paused");
    assert.ok(composingIdx < replyIdx, "composing should come before reply");
    assert.ok(pausedIdx > replyIdx, "paused should come after reply");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario: convertUnsupportedMedia warning for video
// ═══════════════════════════════════════════════════════════════════
describe("convertUnsupportedMedia warning", () => {
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

  it("shows ⚠️ warning and replaces video with placeholder text", async () => {
    const chat = await t.chat("unsupported-video-chat", { enabled: true });
    const r = await chat.send(
      { video: "AAAA", mime: "video/mp4", caption: "Check this video" },
      { llm: ["I see you tried to send a video."] },
    );

    assert.ok(r.raw.some(x => x.source === "warning" && x.text.includes("video")),
      `Should show warning about video, got: ${r.raw.map(x => x.text).join(" | ")}`);

    const userMsg = /** @type {any} */ (r.requests[0]).messages.find(m => m.role === "user");
    const userContent = JSON.stringify(userMsg.content);
    assert.ok(userContent.includes("[Unsupported video"),
      `LLM request should contain placeholder text, got: ${userContent.slice(0, 300)}`);

    assert.ok(r.raw.some(x => x.text.includes("tried to send a video")), "Should deliver final LLM reply");
  });
});

}); // end describe("e2e")
