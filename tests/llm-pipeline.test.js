import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Env vars MUST be set before any dynamic import that triggers config.js
process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { PGlite } from "@electric-sql/pglite";
import { createMockLlmServer, createIncomingContext, createTestDb } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {(msg: IncomingContext) => Promise<void>} */
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

/**
 * @param {string} chatId
 * @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options]
 */
async function seedChat(chatId, options = {}) {
  const enabled = options.enabled ?? false;
  const systemPrompt = options.systemPrompt ?? null;
  const model = options.model ?? null;
  await db.sql`INSERT INTO chats(chat_id, is_enabled, system_prompt, model)
    VALUES (${chatId}, ${enabled}, ${systemPrompt}, ${model})
    ON CONFLICT (chat_id) DO NOTHING`;
}

describe("LLM pipeline via createMessageHandler", () => {
  it("full pipeline: message → store → LLM → response", async () => {
    await seedChat("pipe-1", { enabled: true });
    mockServer.addResponses("Pipeline response!");

    const { context, responses } = createIncomingContext({
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

  it("tool call → action → autoContinue → second LLM call", async () => {
    await seedChat("pipe-2", { enabled: true });

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

    const { context, responses } = createIncomingContext({
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

    const { context, responses } = createIncomingContext({
      chatId: "pipe-3",
      content: [{ type: "text", text: "Do something" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("Tool Error") || r.text.includes("intentional")),
      "Should show error",
    );
    assert.ok(
      responses.some(r => r.text.includes("try differently")),
      "Should have self-correction response",
    );
  });

  it("LLM API error shows error message to user", async () => {
    await seedChat("pipe-4", { enabled: true });
    // Don't add any mock responses — the server will return 500

    const { context, responses } = createIncomingContext({
      chatId: "pipe-4",
      content: [{ type: "text", text: "Trigger error" }],
    });
    await handleMessage(context);

    assert.ok(
      responses.some(r => r.text.includes("Error")),
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

    const { context, responses } = createIncomingContext({
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

    const { context } = createIncomingContext({
      chatId: "pipe-5",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const lastReq = mockServer.getRequests().at(-1);
    const systemMsg = lastReq.messages.find(m => m.role === "system");
    assert.ok(
      systemMsg.content.includes("pirate"),
      "System message should contain custom prompt",
    );
  });

  it("silent action does not send result to user", async () => {
    await seedChat("pipe-silent", { enabled: true });

    // Seed a message so recall_history has something to find
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-silent', 'u1', '{"role":"user","content":[{"type":"text","text":"old msg"}]}', '2026-02-01 08:00:00')`;

    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_silent_001",
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

    const { context, responses } = createIncomingContext({
      chatId: "pipe-silent",
      content: [{ type: "text", text: "What did I say before?" }],
    });
    await handleMessage(context);

    // The tool result should NOT be shown to the user
    assert.ok(
      !responses.some(r => r.text.includes("Recalled") || r.text.includes("old msg")),
      `Silent action result should not be sent to user, but got: ${responses.map(r => r.text).join(" | ")}`,
    );
    // But the LLM should still get a follow-up and respond
    assert.ok(
      responses.some(r => r.text.includes("Based on the history")),
      "Should have final LLM reply after silent tool",
    );

    // The tool result should be stored as a stub in the DB
    const { rows: toolRows } = await db.sql`
      SELECT message_data FROM messages
      WHERE chat_id = 'pipe-silent'
        AND message_data::jsonb->>'role' = 'tool'`;
    assert.equal(toolRows.length, 1, "Silent tool should store a stub in DB");
    const stubData = toolRows[0].message_data;
    assert.equal(stubData.content[0].text, "[recalled prior messages]", "Stub should not contain full result");
  });

  it("clear then continue: LLM only sees post-clear messages", async () => {
    await seedChat("pipe-clear-cont", { enabled: true });

    // First turn: user sends message, LLM replies
    mockServer.addResponses("First reply");
    const { context: ctx1 } = createIncomingContext({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "Remember this secret: ALPHA" }],
    });
    await handleMessage(ctx1);

    // Clear conversation
    mockServer.addResponses(
      {
        tool_calls: [
          {
            id: "call_clear_001",
            type: "function",
            function: { name: "clear_conversation", arguments: "{}" },
          },
        ],
      },
      "Conversation cleared.",
    );
    const { context: ctx2 } = createIncomingContext({
      chatId: "pipe-clear-cont",
      content: [{ type: "text", text: "!clear" }],
    });
    await handleMessage(ctx2);

    // Second turn after clear: new message
    mockServer.addResponses("Post-clear reply");
    const { context: ctx3 } = createIncomingContext({
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

    // Seed messages with known order
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"first msg"}]}', '2026-02-19 08:00:00')`;
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"second msg"}]}', '2026-02-19 09:00:00')`;
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES ('pipe-order', 'u1', '{"role":"user","content":[{"type":"text","text":"third msg"}]}', '2026-02-19 10:00:00')`;

    // Send a new message to trigger the pipeline
    mockServer.addResponses("Order test reply");
    const { context } = createIncomingContext({
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

    const { context } = createIncomingContext({
      chatId: "pipe-6",
      content: [{ type: "text", text: "Hello" }],
    });
    await handleMessage(context);

    const lastReq = mockServer.getRequests().at(-1);
    assert.equal(lastReq.model, "gpt-4.1-nano");
  });
});
