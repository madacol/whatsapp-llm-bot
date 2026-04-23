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

  it("routes !c to harness cancellation", async () => {
    await seedChat("conv-codex-cancel", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'conv-codex-cancel'
    `;

    /** @type {string[]} */
    const cancelledChatIds = [];
    registerHarness("codex", () => ({
      getName: () => "codex",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: true,
        supportsLiveInput: true,
        supportsApprovals: true,
        supportsWorkdir: true,
        supportsSandboxConfig: true,
        supportsModelSelection: true,
        supportsReasoningEffort: false,
        supportsSessionFork: true,
      }),
      cancel: (chatId) => {
        cancelledChatIds.push(typeof chatId === "string" ? chatId : chatId.id);
        return true;
      },
      run: async () => {
        throw new Error("run should not be called for !c");
      },
    }));

    const turn = createChatTurn({
      chatId: "conv-codex-cancel",
      content: [{ type: "text", text: "!c" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(cancelledChatIds, ["conv-codex-cancel"]);
    assert.ok(
      turn.responses.some((response) => response.text === "Cancelled."),
      `Expected !c to cancel the active harness run, got: ${turn.responses.map((response) => response.text).join(" | ")}`,
    );
  });

  it("delivers a final non-text harness response when the harness returns it directly", async () => {
    await seedChat("conv-codex-final-file", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb
      WHERE chat_id = 'conv-codex-final-file'
    `;

    registerHarness("codex", () => ({
      getName: () => "codex",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: true,
        supportsLiveInput: true,
        supportsApprovals: true,
        supportsWorkdir: true,
        supportsSandboxConfig: true,
        supportsModelSelection: true,
        supportsReasoningEffort: false,
        supportsSessionFork: true,
      }),
      handleCommand: async () => false,
      listSlashCommands: () => [],
      run: async () => ({
        response: [{
          type: "file",
          encoding: "base64",
          mime_type: "text/plain",
          file_name: "report.txt",
          data: Buffer.from("report body").toString("base64"),
        }],
        messages: [],
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      }),
    }));

    const turn = createChatTurn({
      chatId: "conv-codex-final-file",
      content: [{ type: "text", text: "Send me the generated report" }],
    });
    await handleMessage(turn.context);

    assert.ok(
      turn.responses.some((response) => response.type === "reply" && response.blockType === "file"),
      `Expected the returned file response to be delivered, got: ${JSON.stringify(turn.responses)}`,
    );
  });

  it("does not refresh composing before the Codex tool-call display", async () => {
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
    const toolCallIndex = turn.responses.findIndex((response) => response.type === "send" && response.text.includes("sleep 3"));
    assert.ok(
      toolCallIndex > firstReplyIndex,
      `Expected the tool-call update after the first Codex reply, got: ${turn.responses.map((response) => `${response.type}:${response.text}`).join(" | ")}`,
    );
    assert.equal(
      composingAfterFirstReplyIndex,
      -1,
      `Did not expect typing to refresh before the tool-call display, got: ${turn.responses.map((response) => `${response.type}:${response.text}`).join(" | ")}`,
    );
    assert.equal(turn.responses.at(-1)?.text, "paused");
  });

  it("shows interleaved llm progress milliseconds after the last visible message", async () => {
    await seedChat("conv-codex-presence-interleaved", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{}'::jsonb,
          output_visibility = '{"tools":true}'::jsonb
      WHERE chat_id = 'conv-codex-presence-interleaved'
    `;

    const maxProgressDelayMs = 120;

    registerHarness("codex", () => createCodexHarness({
      startRun: async (input) => ({
        abortController: new AbortController(),
        done: (async () => {
          await input.hooks?.onLlmResponse?.("Initial progress update");
          await input.hooks?.onToolCall?.({
            id: "dummy-tool-1",
            name: "run_bash",
            arguments: JSON.stringify({ command: "sleep 5" }),
          });
          await input.hooks?.onToolResult?.([{ type: "text", text: "dummy tool output 1" }]);
          await input.hooks?.onLlmResponse?.("Second progress update");
          await input.hooks?.onToolCall?.({
            id: "dummy-tool-2",
            name: "run_bash",
            arguments: JSON.stringify({ command: "sleep 20" }),
          });
          await input.hooks?.onToolResult?.([{ type: "text", text: "dummy tool output 2" }]);
          await input.hooks?.onLlmResponse?.("Final interleaved answer");
          return {
            sessionId: null,
            result: {
              response: [{ type: "markdown", text: "Final interleaved answer" }],
              messages: input.messages,
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            },
          };
        })(),
      }),
    }));

    /** @type {string[]} */
    const presenceEvents = [];
    const turn = createChatTurn({
      chatId: "conv-codex-presence-interleaved",
      content: [{ type: "text", text: "Show interleaved progress" }],
      io: {
        startPresence: async () => {
          presenceEvents.push("start");
        },
        keepPresenceAlive: async () => {
          presenceEvents.push("keepAlive");
        },
        endPresence: async () => {
          presenceEvents.push("end");
        },
      },
    });
    /** @type {Array<{ kind: "send" | "reply", text: string, at: number }>} */
    const visibleMessages = [];
    const originalSend = turn.context.io.send;
    const originalReply = turn.context.io.reply;
    turn.context.io.send = async (event) => {
      const handle = await originalSend(event);
      const text = turn.responses.at(-1)?.text ?? "";
      visibleMessages.push({ kind: "send", text, at: Date.now() });
      return handle;
    };
    turn.context.io.reply = async (event) => {
      const handle = await originalReply(event);
      const text = turn.responses.at(-1)?.text ?? "";
      visibleMessages.push({ kind: "reply", text, at: Date.now() });
      return handle;
    };

    await handleMessage(turn.context);

    assert.deepEqual(
      presenceEvents,
      ["start", "keepAlive", "keepAlive", "end"],
      `Expected only tool-result interleaving to refresh the lease, got: ${presenceEvents.join(" -> ")}`,
    );

    const toolOutput1 = visibleMessages.find((entry) => entry.text.includes("dummy tool output 1"))?.at;
    const secondProgress = visibleMessages.find((entry) => entry.text.includes("Second progress update"))?.at;
    const toolOutput2 = visibleMessages.find((entry) => entry.text.includes("dummy tool output 2"))?.at;
    const finalProgress = visibleMessages.find((entry) => entry.text.includes("Final interleaved answer"))?.at;

    assert.notEqual(toolOutput1, undefined);
    assert.notEqual(secondProgress, undefined);
    assert.notEqual(toolOutput2, undefined);
    assert.notEqual(finalProgress, undefined);

    assert.ok(
      secondProgress - toolOutput1 < maxProgressDelayMs,
      `Expected second llm progress milliseconds after the prior visible tool result, got ${secondProgress - toolOutput1}ms: ${JSON.stringify(visibleMessages)}`,
    );
    assert.ok(
      finalProgress - toolOutput2 < maxProgressDelayMs,
      `Expected final llm progress milliseconds after the prior visible tool result, got ${finalProgress - toolOutput2}ms: ${JSON.stringify(visibleMessages)}`,
    );

    const responseTexts = turn.responses.map((response) => response.text);
    assert.ok(
      responseTexts.includes("Initial progress update")
      && responseTexts.includes("dummy tool output 1")
      && responseTexts.includes("Second progress update")
      && responseTexts.includes("dummy tool output 2")
      && responseTexts.includes("Final interleaved answer"),
      `Expected interleaved dummy progress and tool output, got: ${responseTexts.join(" | ")}`,
    );
  });
});
