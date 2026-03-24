import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";

import { createChatTurn, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {import("@electric-sql/pglite").PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;
/** @type {typeof import("../harnesses/index.js").registerHarness} */
let registerHarness;
/** @type {typeof import("../harnesses/codex.js").createCodexHarness} */
let createCodexHarness;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
  ({ registerHarness } = await import("../harnesses/index.js"));
  ({ createCodexHarness } = await import("../harnesses/codex.js"));

  const runner = createConversationRunner({
    store,
    llmClient: /** @type {LlmClient} */ ({}),
    getActionsFn: async () => [],
    executeActionFn: async () => {
      throw new Error("executeAction should not be called");
    },
  });
  handleMessage = runner.handleMessage;
});

afterEach(() => {
  registerHarness("codex", createCodexHarness);
});

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(db, chatId, options);

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

describe("createConversationRunner with codex harness", () => {
  it("shows a startup failure, clears the stale session, and recovers on the next turn", async () => {
    await seedChat("conv-codex-recover", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb,
          harness_session_id = 'sess-stale',
          harness_session_kind = 'codex'
      WHERE chat_id = 'conv-codex-recover'
    `;

    /** @type {Array<string | null>} */
    const seenSessionIds = [];
    let attemptCount = 0;
    registerHarness("codex", () => createCodexHarness({
      startRun: async (input) => {
        seenSessionIds.push(input.sessionId ?? null);
        attemptCount += 1;
        if (attemptCount === 1) {
          return {
            abortController: new AbortController(),
            done: Promise.reject(new Error("Codex Exec exited with code 1: Reading prompt from stdin...")),
          };
        }
        return {
          abortController: new AbortController(),
          done: (async () => {
            await input.hooks?.onLlmResponse?.("Recovered after clearing session");
            return {
              sessionId: "sess-fresh",
              result: {
                response: [{ type: "markdown", text: "Recovered after clearing session" }],
                messages: input.messages,
                usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
              },
            };
          })(),
        };
      },
    }));

    const firstTurn = createChatTurn({
      chatId: "conv-codex-recover",
      content: [{ type: "text", text: "Trigger the stale codex session" }],
    });
    await handleMessage(firstTurn.context);

    assert.ok(
      firstTurn.responses.some((response) => response.source === "error" && response.text.includes("Codex Exec exited with code 1")),
      `Expected the first turn to show the Codex startup failure, got: ${firstTurn.responses.map((response) => response.text).join(" | ")}`,
    );

    let chat = await store.getChat("conv-codex-recover");
    assert.equal(chat?.harness_session_id, null);
    assert.equal(chat?.harness_session_kind, null);

    const secondTurn = createChatTurn({
      chatId: "conv-codex-recover",
      content: [{ type: "text", text: "Try again after clearing the session" }],
    });
    await handleMessage(secondTurn.context);

    assert.ok(
      secondTurn.responses.some((response) => response.text.includes("Recovered after clearing session")),
      `Expected the second turn to recover cleanly, got: ${secondTurn.responses.map((response) => response.text).join(" | ")}`,
    );

    chat = await store.getChat("conv-codex-recover");
    assert.equal(chat?.harness_session_id, "sess-fresh");
    assert.equal(chat?.harness_session_kind, "codex");
    assert.deepEqual(seenSessionIds, ["sess-stale", null]);
  });

  it("steers follow-up turns into the active Codex run", async () => {
    await seedChat("conv-codex-queue", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'conv-codex-queue'
    `;

    /** @type {string[]} */
    const seenPrompts = [];
    /** @type {string[]} */
    const steeredPrompts = [];
    /** @type {() => void} */
    let releaseFirstRun = () => {};
    const firstRunReleased = new Promise((resolve) => {
      releaseFirstRun = resolve;
    });
    /** @type {() => void} */
    let notifyFirstRunStarted = () => {};
    const firstRunStarted = new Promise((resolve) => {
      notifyFirstRunStarted = resolve;
    });
    let runCount = 0;

    registerHarness("codex", () => createCodexHarness({
      startRun: async (input) => {
        runCount += 1;
        const prompt = getLastUserText(input.messages);
        seenPrompts.push(prompt);

        return {
          abortController: new AbortController(),
          steer: async (text) => {
            steeredPrompts.push(text);
            return true;
          },
          done: (async () => {
            await input.hooks?.onLlmResponse?.(`Response for ${prompt}`);
            if (runCount === 1) {
              notifyFirstRunStarted();
              await firstRunReleased;
            }
            return {
              sessionId: null,
              result: {
                response: [{ type: "markdown", text: `Response for ${prompt}` }],
                messages: input.messages,
                usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
              },
            };
          })(),
        };
      },
    }));

    const firstTurn = createChatTurn({
      chatId: "conv-codex-queue",
      content: [{ type: "text", text: "First question" }],
    });
    const secondTurn = createChatTurn({
      chatId: "conv-codex-queue",
      content: [{ type: "text", text: "Second question" }],
    });

    const firstTurnPromise = handleMessage(firstTurn.context);
    await firstRunStarted;

    await handleMessage(secondTurn.context);
    assert.equal(seenPrompts.length, 1);
    assert.ok(seenPrompts[0]?.includes("First question"));
    assert.equal(steeredPrompts.length, 1);
    assert.ok(steeredPrompts[0]?.includes("Second question"));

    releaseFirstRun();
    await firstTurnPromise;

    assert.equal(seenPrompts.length, 1);
    assert.ok(seenPrompts[0]?.includes("First question"));
    assert.ok(
      firstTurn.responses.some((response) => response.text.includes("Response for") && response.text.includes("First question")),
      `Expected the first turn to respond, got: ${firstTurn.responses.map((response) => response.text).join(" | ")}`,
    );
    assert.equal(secondTurn.responses.length, 0);
  });

  it("refreshes composing after intermediate Codex replies and tool calls until the run finishes", async () => {
    await seedChat("conv-codex-presence", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'conv-codex-presence'
    `;

    registerHarness("codex", () => createCodexHarness({
      startRun: async (input) => ({
        abortController: new AbortController(),
        done: (async () => {
          await input.hooks?.onLlmResponse?.("First Codex progress update");
          await input.hooks?.onToolCall?.({
            id: "dummy-tool-1",
            name: "run_bash",
            arguments: JSON.stringify({ command: "sleep 3" }),
          });
          await input.hooks?.onLlmResponse?.("Final Codex answer");
          return {
            sessionId: null,
            result: {
              response: [{ type: "markdown", text: "Final Codex answer" }],
              messages: input.messages,
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            },
          };
        })(),
      }),
    }));

    const turn = createChatTurn({
      chatId: "conv-codex-presence",
      content: [{ type: "text", text: "Show progress while you work" }],
    });
    await handleMessage(turn.context);

    const firstReplyIndex = turn.responses.findIndex((response) => response.text.includes("First Codex progress update"));
    assert.ok(firstReplyIndex >= 0, `Expected an intermediate Codex reply, got: ${turn.responses.map((response) => response.text).join(" | ")}`);

    const composingAfterFirstReplyIndex = turn.responses.findIndex((response, index) => (
      index > firstReplyIndex
      && response.type === "sendPresenceUpdate"
      && response.text === "composing"
    ));
    assert.ok(
      composingAfterFirstReplyIndex > firstReplyIndex,
      `Expected typing to refresh after the first Codex reply, got: ${turn.responses.map((response) => `${response.type}:${response.text}`).join(" | ")}`,
    );

    const toolCallIndex = turn.responses.findIndex((response) => response.type === "send" && response.text.includes("sleep 3"));
    assert.ok(toolCallIndex > composingAfterFirstReplyIndex, `Expected a tool-call update after typing restarted, got: ${turn.responses.map((response) => `${response.type}:${response.text}`).join(" | ")}`);

    const composingAfterToolCallIndex = turn.responses.findIndex((response, index) => (
      index > toolCallIndex
      && response.type === "sendPresenceUpdate"
      && response.text === "composing"
    ));
    assert.ok(
      composingAfterToolCallIndex > toolCallIndex,
      `Expected typing to refresh after the tool-call update, got: ${turn.responses.map((response) => `${response.type}:${response.text}`).join(" | ")}`,
    );
    assert.equal(turn.responses.at(-1)?.text, "paused");
  });
});
