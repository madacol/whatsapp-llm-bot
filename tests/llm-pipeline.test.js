import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { PGlite } from "@electric-sql/pglite";
import { createMockLlmServer, createChatTurn, createTestDb, seedChat as seedChat_, withModelsCache } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;

  // Dynamic imports so config.js sees our env vars
  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();

  const { createMessageHandler } = await import("../index.js");
  const { getActions, executeAction } = await import("../actions.js");

  const handler = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
  });
  handleMessage = handler.handleMessage;
});

after(async () => {
  await mockServer?.close();
});

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(db, chatId, options);

describe("LLM pipeline via createMessageHandler", () => {
  afterEach(() => {
    const pending = mockServer.pendingResponses();
    assert.equal(pending, 0, `Mock response queue should be empty after each test, but has ${pending} unconsumed response(s). This will corrupt subsequent tests.`);
  });

  it("full pipeline: message → store → LLM → response", async () => {
    await seedChat("pipe-1", { enabled: true });
    mockServer.addResponses("Pipeline response!");

    const { context, responses } = createChatTurn({
      chatId: "pipe-1",
      content: [{ type: "text", text: "Test message" }],
    });
    await handleMessage(context);

    assert.ok(responses.length > 0, "Should have responses");
    assert.ok(
      responses.some(r => r.text.includes("Pipeline response!")),
      "Should contain LLM response",
    );
  });

  it("allows freeform LLM work in project chats", async () => {
    await seedChat("pipe-repo-chat", { enabled: true });
    await store.createProject({
      name: "pipe-repo",
      rootPath: "/repo/main",
      defaultBaseBranch: "master",
      controlChatId: "pipe-repo-chat",
    });
    mockServer.addResponses("Repo chat response!");

    const requestCountBefore = mockServer.getRequests().length;
    const { context, responses } = createChatTurn({
      chatId: "pipe-repo-chat",
      content: [{ type: "text", text: "implement retry logic" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some((response) => response.text.includes("Repo chat response!")),
      `Expected project-chat LLM response, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
    assert.ok(
      mockServer.getRequests().length > requestCountBefore,
      "Repo chat freeform should hit the LLM",
    );
  });

  it("tool call → action → autoContinue → second LLM call", async () => {
    await seedChat("pipe-2", { enabled: true });
    // Tool call output is now always visible (debug mode no longer gates it)

    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_pipe_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "({chatId}) => `ID: ${chatId}`" }),
            },
          },
        ],
      },
      "The result was received!",
    );

    const { context, responses } = createChatTurn({
      chatId: "pipe-2",
      content: [{ type: "text", text: "Run something" }],
    });
    await handleMessage(context);

    assert.ok(responses.length >= 3, `Expected >= 3 responses, got ${responses.length}`);
    assert.ok(
      responses.some(r => r.text.includes("run_javascript")),
      "Should show tool execution",
    );
    assert.ok(
      responses.some(r => r.text.includes("The result was received!")),
      "Should have final LLM reply",
    );
  });

  it("tool error triggers autoContinue for self-correction", async () => {
    await seedChat("pipe-3", { enabled: true });

    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_pipe_err",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "() => { throw new Error('intentional') }" }),
            },
          },
        ],
      },
      "I see there was an error, let me try differently.",
    );

    const { context, responses } = createChatTurn({
      chatId: "pipe-3",
      content: [{ type: "text", text: "Do something" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some((r) => r.type === "edit" && r.text.includes("❌ *run_javascript*")),
      "Should update the tool-call message with a failure marker",
    );
    assert.ok(
      !responses.some((r) => r.source === "error"),
      "Should not send a separate error message when the tool-call message exists",
    );
    assert.ok(
      responses.some(r => r.text.includes("try differently")),
      "Should have self-correction response",
    );
  });

  it("LLM API error shows error message to user", async () => {
    await seedChat("pipe-4", { enabled: true });
    // Don't add any mock responses — the server will return 500

    const { context, responses } = createChatTurn({
      chatId: "pipe-4",
      content: [{ type: "text", text: "Trigger error" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.source === "error"),
      "Should show error to user",
    );
  });

  it("does not crash on malformed tool call arguments", async () => {
    await seedChat("pipe-malformed", { enabled: true });

    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_malformed_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: "{bad json",
            },
          },
        ],
      },
      "Recovered from bad args",
    );

    const { context, responses } = createChatTurn({
      chatId: "pipe-malformed",
      content: [{ type: "text", text: "Do something" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("Recovered") || r.text.includes("Error")),
      "Should recover from malformed arguments without crashing",
    );
  });

  it("uses custom system prompt from chat", async () => {
    await seedChat("pipe-5", { enabled: true, systemPrompt: "You are a pirate" });
    mockServer.addResponses("Arr matey!");

    const { context } = createChatTurn({
      chatId: "pipe-5",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const lastReq = mockServer.getRequests().at(-1);
    const systemMsg = lastReq.messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content) ? systemMsg.content[0].text : systemMsg.content;
    assert.ok(
      systemText.includes("pirate"),
      "System message should contain custom prompt",
    );
  });

  it("delegates harness-owned slash commands through handleCommand", async () => {
    await seedChat("pipe-slash-1", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'claude-agent-sdk',
          harness_config = '{"model":"claude-sonnet-4-6","reasoningEffort":"medium"}'::jsonb
      WHERE chat_id = 'pipe-slash-1'
    `;

    const { context, responses } = createChatTurn({
      chatId: "pipe-slash-1",
      content: [{ type: "text", text: "/model off" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("SDK model reset to default.")),
      "Expected slash command to be delegated to the active harness",
    );
  });

  it("delegates codex harness commands through handleCommand", async () => {
    await seedChat("pipe-slash-codex", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'pipe-slash-codex'
    `;

    const { context, responses } = createChatTurn({
      chatId: "pipe-slash-codex",
      content: [{ type: "text", text: "/model gpt-5.4" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("Codex model set")),
      "Expected slash command to be delegated to the codex harness",
    );
  });

  it("clears harness sessions through the active harness command surface", async () => {
    await seedChat("pipe-slash-clear", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'native',
          model_roles = '{"fast":"mock-fast-model"}'::jsonb,
          harness_session_id = 'sess-clear-1',
          harness_session_kind = 'native',
          harness_session_history = '[]'::jsonb
      WHERE chat_id = 'pipe-slash-clear'
    `;
    await db.sql`
      INSERT INTO messages(chat_id, sender_id, message_data)
      VALUES
        ('pipe-slash-clear', 'u1', '{"role":"user","content":[{"type":"text","text":"We are debugging a slow sync job"}]}'),
        ('pipe-slash-clear', null, '{"role":"assistant","content":[{"type":"text","text":"The bottleneck seems to be duplicate writes"}]}')
    `;
    mockServer.addResponses("Slow sync job debugging");

    const { context, responses } = createChatTurn({
      chatId: "pipe-slash-clear",
      content: [{ type: "text", text: "/clear" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("Session cleared")),
      "Expected /clear to be handled via the active harness",
    );

    const { rows: [chat] } = await db.sql`
      SELECT harness_session_id, harness_session_kind, harness_session_history
      FROM chats
      WHERE chat_id = 'pipe-slash-clear'
    `;
    assert.equal(chat.harness_session_id, null);
    assert.equal(chat.harness_session_kind, null);
    assert.equal(chat.harness_session_history.length, 1);
    assert.equal(chat.harness_session_history[0].id, "sess-clear-1");
    assert.equal(chat.harness_session_history[0].kind, "native");
    assert.equal(chat.harness_session_history[0].title, "Slow sync job debugging");

    const [summaryRequest] = mockServer.getRequests().slice(-1);
    assert.equal(summaryRequest.model, "mock-fast-model");
  });

  it("returns available slash commands when a slash command is not handled", async () => {
    await seedChat("pipe-slash-unknown", { enabled: true });

    const requestCountBefore = mockServer.getRequests().length;
    const { context, responses } = createChatTurn({
      chatId: "pipe-slash-unknown",
      content: [{ type: "text", text: "/status" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some((response) => response.text.includes("Available slash commands")),
      `Expected available slash commands reply, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
    assert.ok(
      responses.some((response) => response.text.includes("/clear") && response.text.includes("/resume")),
      `Expected native slash command list, got: ${responses.map((response) => response.text).join(" | ")}`,
    );
    assert.equal(
      mockServer.getRequests().length,
      requestCountBefore,
      "Unknown slash commands should not fall through to the regular LLM path",
    );
  });

  it("recall_history stores full result in DB", async () => {
    await seedChat("pipe-recall", { enabled: true });

    // Seed a message so recall_history has something to find
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-recall', 'u1', '{"role":"user","content":[{"type":"text","text":"old msg"}]}', '2026-02-01 08:00:00')`;

    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_recall_001",
            type: "function",
            function: {
              name: "recall_history",
              arguments: JSON.stringify({ since: "2026-02-01T00:00:00Z" }),
            },
          },
        ],
      },
      "Based on the history, here is my answer.",
    );

    const { context, responses } = createChatTurn({
      chatId: "pipe-recall",
      content: [{ type: "text", text: "What did I say before?" }],
    });
    await handleMessage(context);

    // The LLM should get a follow-up and respond
    assert.ok(
      responses.some(r => r.text.includes("Based on the history")),
      "Should have final LLM reply after recall tool",
    );

    // The tool result should be stored with full content in the DB
    const { rows: toolRows } = await db.sql`
      SELECT message_data FROM messages
      WHERE chat_id = 'pipe-recall'
        AND message_data::jsonb->>'role' = 'tool'`;
    assert.equal(toolRows.length, 1, "Tool result should be stored in DB");
    const resultData = toolRows[0].message_data;
    assert.ok(resultData.content[0].text.includes("Recalled"), "Should contain full recall result");
  });

  it("clear then continue: LLM only sees post-clear messages", async () => {
    await seedChat("pipe-clear-cont", { enabled: true });

    // First turn: user sends message, LLM replies
    mockServer.addResponses("First reply");
    const { context: ctx1 } = createChatTurn({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "Remember this secret: ALPHA" }],
    });
    await handleMessage(ctx1);

    // Clear conversation (command path — bypasses LLM, no mock responses needed)
    const { context: ctx2 } = createChatTurn({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "!clear" }],
    });
    await handleMessage(ctx2);

    // Second turn after clear: new message
    mockServer.addResponses("Post-clear reply");
    const { context: ctx3 } = createChatTurn({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "What do you know?" }],
    });
    await handleMessage(ctx3);

    // The LLM request for the third turn should NOT contain the pre-clear messages
    const lastReq = mockServer.getRequests().at(-1);
    const allContent = JSON.stringify(lastReq.messages);
    assert.ok(
      !allContent.includes("ALPHA"),
      `Post-clear LLM context should not contain pre-clear message "ALPHA", but got: ${allContent}`,
    );
    assert.ok(
      allContent.includes("What do you know?"),
      "Post-clear LLM context should contain the new message",
    );
  });

  it("getMessages DESC + formatMessagesForOpenAI produces chronological order", async () => {
    await seedChat("pipe-order", { enabled: true });

    // Seed messages with known order (within the 8h default window)
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"first msg"}]}', ${threeHoursAgo})`;
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"second msg"}]}', ${twoHoursAgo})`;
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"third msg"}]}', ${oneHourAgo})`;

    // Send a new message to trigger the pipeline
    mockServer.addResponses("Order test reply");
    const { context } = createChatTurn({
      chatId: "pipe-order",
      content: [{ type: "text", text: "fourth msg" }],
    });
    await handleMessage(context);

    // Check the LLM request: messages should be in chronological order
    const lastReq = mockServer.getRequests().at(-1);
    const userMsgs = lastReq.messages.filter(m =>
      m.role === "user" && JSON.stringify(m.content).includes("msg")
    );
    const allText = JSON.stringify(userMsgs);
    // Find position of each marker in the serialized message sequence
    const pos1 = allText.indexOf("first msg");
    const pos2 = allText.indexOf("second msg");
    const pos3 = allText.indexOf("third msg");
    const pos4 = allText.indexOf("fourth msg");
    // All should be present
    assert.ok(pos1 >= 0, "first msg should be in context");
    assert.ok(pos4 >= 0, "fourth msg should be in context");
    // Should be oldest first (chronological)
    assert.ok(pos1 < pos2, "first before second");
    assert.ok(pos2 < pos3, "second before third");
    assert.ok(pos3 < pos4, "third before fourth");
  });

  it("uses custom model from chat", async () => {
    await seedChat("pipe-6", { enabled: true, model: "gpt-4.1-nano" });
    mockServer.addResponses("Model test");

    const { context } = createChatTurn({
      chatId: "pipe-6",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const lastReq = mockServer.getRequests().at(-1);
    assert.equal(lastReq.model, "gpt-4.1-nano");
  });

  it("system message uses cache_control content array format", async () => {
    await seedChat("pipe-cache", { enabled: true });
    mockServer.addResponses("Cache test");

    const { context } = createChatTurn({
      chatId: "pipe-cache",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const lastReq = mockServer.getRequests().at(-1);
    const systemMsg = lastReq.messages.find(m => m.role === "system");
    assert.ok(Array.isArray(systemMsg.content), "System message content should be an array");
    assert.equal(systemMsg.content[0].type, "text");
    assert.ok(systemMsg.content[0].text.length > 0, "System text should be non-empty");
    assert.deepStrictEqual(
      systemMsg.content[0].cache_control,
      { type: "ephemeral" },
      "System message should have cache_control marker",
    );
  });

  it("system prompt does not include action instructions by default", async () => {
    await seedChat("pipe-no-instr", { enabled: true });
    mockServer.addResponses("Plain reply");

    const { context } = createChatTurn({
      chatId: "pipe-no-instr",
      content: [{ type: "text", text: "Hello there" }],
    });
    await handleMessage(context);

    const lastReq = mockServer.getRequests().at(-1);
    const systemMsg = lastReq.messages.find(m => m.role === "system");
    const systemText = Array.isArray(systemMsg.content) ? systemMsg.content[0].text : systemMsg.content;
    assert.ok(
      !systemText.includes("ActionContext"),
      `System prompt should NOT contain action instructions by default, but found "ActionContext"`,
    );
  });

  it("action instructions are injected after tool is called", async () => {
    await seedChat("pipe-instr", { enabled: true });
    const reqsBefore = mockServer.getRequests().length;

    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_instr_001",
            type: "function",
            function: {
              name: "run_javascript",
              arguments: JSON.stringify({ code: "({chatId}) => chatId" }),
            },
          },
        ],
      },
      "Got the result!",
    );

    const { context } = createChatTurn({
      chatId: "pipe-instr",
      content: [{ type: "text", text: "Run some code" }],
    });
    await handleMessage(context);

    // Grab only the requests from this test
    const chatReqs = mockServer.getRequests().slice(reqsBefore);
    assert.ok(chatReqs.length >= 2, `Expected at least 2 LLM requests, got ${chatReqs.length}`);

    const firstSystem = chatReqs[0].messages.find(m => m.role === "system");
    const firstText = Array.isArray(firstSystem.content) ? firstSystem.content[0].text : firstSystem.content;
    assert.ok(
      !firstText.includes("ActionContext"),
      "First LLM request should NOT contain action instructions",
    );

    const secondSystem = chatReqs[1].messages.find(m => m.role === "system");
    const secondText = Array.isArray(secondSystem.content) ? secondSystem.content[0].text : secondSystem.content;
    assert.ok(
      secondText.includes("ActionContext"),
      "Second LLM request SHOULD contain action instructions after tool was called",
    );
  });

  it("logs usage stats after LLM response", async () => {
    await seedChat("pipe-usage", { enabled: true });
    mockServer.addResponses("Usage test");

    const logs = [];
    const origLog = console.log;
    const origLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    console.log = (...args) => {
      logs.push(args.join(" "));
      origLog.apply(console, args);
    };

    try {
      const { context } = createChatTurn({
        chatId: "pipe-usage",
        content: [{ type: "text", text: "Hello" }],
      });
      await handleMessage(context);
    } finally {
      console.log = origLog;
      if (origLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = origLevel;
    }

    const usageLine = logs.find(l => l.includes("[LLM usage]"));
    assert.ok(usageLine, `Expected a log line with "[LLM usage]", got: ${logs.join("\n")}`);
    assert.ok(usageLine.includes("prompt="), "Should log prompt tokens");
    assert.ok(usageLine.includes("cached="), "Should log cached tokens");
    assert.ok(usageLine.includes("completion="), "Should log completion tokens");
    assert.ok(usageLine.includes("model="), "Should log model name");
  });

  it("sends composing presence before LLM and paused after", async () => {
    await seedChat("pipe-presence", { enabled: true });
    mockServer.addResponses("Presence test reply");

    const { context, responses } = createChatTurn({
      chatId: "pipe-presence",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const presenceUpdates = responses.filter(r => r.type === "sendPresenceUpdate");
    assert.ok(
      presenceUpdates.length >= 2,
      `Expected at least 2 presence updates (composing + paused), got ${presenceUpdates.length}: ${JSON.stringify(presenceUpdates)}`,
    );
    assert.equal(presenceUpdates[0].text, "composing", "First presence update should be composing");
    assert.equal(presenceUpdates.at(-1).text, "paused", "Last presence update should be paused");

    // composing should happen before the LLM response
    const composingIdx = responses.indexOf(presenceUpdates[0]);
    const replyIdx = responses.findIndex(r => r.text.includes("Presence test reply"));
    assert.ok(composingIdx < replyIdx, "composing should be sent before the LLM reply");
  });

  it("sends paused presence even when LLM errors", async () => {
    await seedChat("pipe-presence-err", { enabled: true });
    // No mock responses → server returns 500

    const { context, responses } = createChatTurn({
      chatId: "pipe-presence-err",
      content: [{ type: "text", text: "Trigger error" }],
    });
    await handleMessage(context);

    const presenceUpdates = responses.filter(r => r.type === "sendPresenceUpdate");
    assert.equal(presenceUpdates.at(-1)?.text, "paused", "Should send paused even on error");
  });

  it("does not send composing when bot decides not to respond", async () => {
    await seedChat("pipe-presence-skip", { enabled: false });

    const { context, responses } = createChatTurn({
      chatId: "pipe-presence-skip",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const presenceUpdates = responses.filter(r => r.type === "sendPresenceUpdate");
    assert.equal(presenceUpdates.length, 0, "Should not send presence when not responding");
  });

  it("persists usage row to DB after LLM response", async () => {
    await seedChat("pipe-usage-db", { enabled: true });
    mockServer.addResponses("Persist usage test");

    const { context } = createChatTurn({
      chatId: "pipe-usage-db",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    // Give the fire-and-forget recordUsage a moment to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { rows } = await db.query(
      "SELECT * FROM usage_logs WHERE chat_id = $1",
      ["pipe-usage-db"],
    );
    assert.equal(rows.length, 1, "Should persist exactly one usage row");
    assert.equal(rows[0].prompt_tokens, 10);
    assert.equal(rows[0].completion_tokens, 5);
    assert.equal(rows[0].cached_tokens, 8);
    assert.equal(rows[0].cost, 0.001);
    assert.equal(rows[0].model, "mock-model");
  });

  it("appends system prompt hint when conversation contains media", async () => {
    const modelsCache = [
      { id: "mock-model", architecture: { input_modalities: ["text", "image", "video", "audio"] } },
    ];
    await withModelsCache(modelsCache, async () => {
      await seedChat("pipe-media-hint", { enabled: true });

      // Seed a message with an image so the media registry is non-empty
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('pipe-media-hint', 'u1', ${JSON.stringify({
          role: "user",
          content: [{ type: "image", mime_type: "image/png", data: "abc", encoding: "base64" }],
        })}, ${twoHoursAgo})`;

      mockServer.addResponses("I see the image!");

      const { context } = createChatTurn({
        chatId: "pipe-media-hint",
        content: [{ type: "text", text: "What is in the image?" }],
      });
      await handleMessage(context);

      const lastReq = mockServer.getRequests().at(-1);
      const systemMsg = lastReq.messages.find(m => m.role === "system");
      const systemText = Array.isArray(systemMsg.content) ? systemMsg.content[0].text : systemMsg.content;
      assert.ok(
        systemText.includes("canonical file paths"),
        "System prompt should contain media file-path hint when media is present",
      );
      assert.ok(
        systemText.includes("<sha>.jpg"),
        "System prompt hint should mention passing media file paths as parameter values",
      );
    });
  });

  it("converts image params in tool schemas when media is present", async () => {
    const modelsCache = [
      { id: "mock-model", architecture: { input_modalities: ["text", "image", "video", "audio"] } },
    ];
    await withModelsCache(modelsCache, async () => {
      await seedChat("pipe-media-tools", { enabled: true });

      // Seed a message with an image
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
        VALUES ('pipe-media-tools', 'u1', ${JSON.stringify({
          role: "user",
          content: [{ type: "image", mime_type: "image/png", data: "abc", encoding: "base64" }],
        })}, ${twoHoursAgo})`;

      mockServer.addResponses("Got it!");

      const { context } = createChatTurn({
        chatId: "pipe-media-tools",
        content: [{ type: "text", text: "What do you see?" }],
      });
      await handleMessage(context);

      const lastReq = mockServer.getRequests().at(-1);
      const tools = lastReq.tools;
      assert.ok(tools.length > 0, "Should have tools");
      // Tools with image params should have them converted to string type
      const imageTools = tools.filter(t =>
        Object.values(t.function.parameters.properties).some(p => p.description?.includes("file path"))
      );
      assert.ok(imageTools.length > 0, "At least one tool should have image params with media hint");
      // Non-image tools should NOT have media refs injected
      for (const tool of tools) {
        assert.ok(
          !tool.function.parameters.properties._media_refs,
          `Tool "${tool.function.name}" should NOT have legacy _media_refs`,
        );
      }
    });
  });

  it("does not add media hints to tool schemas when no media is present", async () => {
    await seedChat("pipe-no-media-tools", { enabled: true });
    mockServer.addResponses("Text only!");

    const { context } = createChatTurn({
      chatId: "pipe-no-media-tools",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const lastReq = mockServer.getRequests().at(-1);
    const tools = lastReq.tools;
    assert.ok(tools.length > 0, "Should have tools");
    // No tool should mention runtime media file hints when no media is present
    for (const tool of tools) {
      const hasMediaHint = Object.values(tool.function.parameters.properties).some(
        p => p.description?.includes("<sha>.jpg")
      );
      assert.ok(
        !hasMediaHint,
        `Tool "${tool.function.name}" should NOT have media hints when no media`,
      );
    }
  });
});
