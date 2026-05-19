import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";

import { createChatTurn, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";
import { updateChatConfig } from "../chat-config.js";

/** @type {import("@electric-sql/pglite").PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {(msg: ChatTurn) => Promise<void>} */
let handleMessage;
/** @type {typeof import("../harnesses/index.js").registerHarness} */
let registerHarness;
/** @type {typeof import("../harnesses/index.js").registerHarnessDriver} */
let registerHarnessDriver;
/** @type {typeof import("../harnesses/codex.js").createCodexHarness} */
let createCodexHarness;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
  ({ registerHarness, registerHarnessDriver } = await import("../harnesses/index.js"));
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

describe("createConversationRunner prompt formatting", () => {
  it("starts the selected harness adapter session before sending the turn", async () => {
    await seedChat("conv-adapter-session-start", { enabled: true });
    await updateChatConfig("conv-adapter-session-start", (current) => ({
      ...current,
      harness: "adapter-lifecycle",
      harness_config: {
        activeHarnessInstances: { "adapter-lifecycle": "work" },
        harnessInstances: {
          "adapter-lifecycle": {
            work: { model: "model-a" },
          },
        },
      },
    }));

    /** @type {string[]} */
    const phases = [];
    registerHarnessDriver("adapter-lifecycle", () => ({
      getName: () => "adapter-lifecycle",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: false,
        supportsLiveInput: false,
        supportsApprovals: false,
        supportsWorkdir: true,
        supportsSandboxConfig: false,
        supportsModelSelection: true,
        supportsReasoningEffort: false,
        supportsSessionFork: false,
      }),
      async run() {
        phases.push("legacy-run");
        return {
          response: [{ type: "text", text: "ok" }],
          messages: [],
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        };
      },
      handleCommand: async () => false,
      listSlashCommands: () => [],
      createAdapter() {
        return {
          async startSession(input) {
            phases.push(`start:${input.chatId}:${input.runConfig?.model ?? ""}`);
            return {
              chatId: input.chatId,
              harnessName: "adapter-lifecycle",
              instanceId: "work",
              continuationKey: "adapter-lifecycle:instance:work",
              status: "ready",
              model: input.runConfig?.model ?? null,
              resumeCursor: input.resumeCursor ?? null,
            };
          },
          async sendTurn(input) {
            phases.push("send");
            assert.ok("params" in input, "current runner should preserve the compatibility path");
            return {
              response: [{ type: "text", text: "ok" }],
              messages: input.params.messages,
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            };
          },
          interruptTurn: async () => false,
          injectMessage: async () => false,
          stopSession: async () => false,
          listSessions: () => [],
          readThread: async () => null,
          rollbackThread: async () => null,
          streamEvents: {
            async *[Symbol.asyncIterator]() {},
          },
        };
      },
    }), {
      supportsInstances: true,
    });

    const turn = createChatTurn({
      chatId: "conv-adapter-session-start",
      content: [{ type: "text", text: "hello" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(phases, ["start:conv-adapter-session-start:model-a", "send"]);
  });

  it("uses semantic adapter turns and presents runtime events outside the harness", async () => {
    await seedChat("conv-semantic-events", { enabled: true });
    await updateChatConfig("conv-semantic-events", (current) => ({
      ...current,
      harness: "semantic-events",
      harness_config: {},
    }));

    /** @type {Array<({ type: string, provider: string } & Record<string, unknown>) => void | Promise<void>>} */
    const subscribers = [];
    /** @type {string[]} */
    const phases = [];
    /** @type {SendContent[]} */
    const replies = [];
    registerHarnessDriver("semantic-events", () => ({
      getName: () => "semantic-events",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: false,
        supportsLiveInput: false,
        supportsApprovals: false,
        supportsWorkdir: true,
        supportsSandboxConfig: false,
        supportsModelSelection: true,
        supportsReasoningEffort: false,
        supportsSessionFork: false,
      }),
      async run() {
        assert.fail("semantic adapter should not use legacy run");
      },
      handleCommand: async () => false,
      listSlashCommands: () => [],
      createAdapter() {
        return {
          supportsSemanticTurns: true,
          async startSession(input) {
            phases.push("start");
            return {
              chatId: input.chatId,
              harnessName: "semantic-events",
              instanceId: "default",
              continuationKey: "semantic-events:instance:default",
              status: "ready",
              resumeCursor: null,
            };
          },
          async sendTurn(input) {
            phases.push("semantic-send");
            assert.ok("turn" in input, "Expected semantic turn input");
            assert.equal(input.turn.chatId, "conv-semantic-events");
            assert.ok(input.turn.messages?.some((message) => message.role === "user"));
            for (const subscriber of subscribers) {
              await subscriber({
                type: "assistant.completed",
                provider: "semantic-events",
                text: "event response",
                contentType: "text",
                responseMode: "replace",
              });
            }
            return {
              response: [{ type: "text", text: "fallback response" }],
              messages: input.turn.messages ?? [],
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            };
          },
          interruptTurn: async () => false,
          injectMessage: async () => false,
          stopSession: async () => false,
          listSessions: () => [],
          readThread: async () => null,
          rollbackThread: async () => null,
          streamEvents: {
            async *[Symbol.asyncIterator]() {},
          },
          subscribeEvents(handler) {
            subscribers.push(handler);
            return () => {
              const index = subscribers.indexOf(handler);
              if (index >= 0) {
                subscribers.splice(index, 1);
              }
            };
          },
        };
      },
    }));

    const turn = createChatTurn({
      chatId: "conv-semantic-events",
      content: [{ type: "text", text: "hello" }],
      io: {
        reply: async (event) => {
          if (event.kind === "content") {
            replies.push(event.content);
          }
          return undefined;
        },
      },
    });
    await handleMessage(turn.context);

    assert.deepEqual(phases, ["start", "semantic-send"]);
    assert.deepEqual(replies, [[{ type: "markdown", text: "event response" }]]);
  });

  it("runs command afterResponse hooks only after the command reply resolves", async () => {
    await seedChat("conv-command-after-response", { enabled: true });
    const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
    /** @type {string[]} */
    const phases = [];
    const runner = createConversationRunner({
      store,
      llmClient: /** @type {LlmClient} */ ({}),
      getActionsFn: async () => [{
        name: "restart",
        command: "restart",
        description: "Restart the bot process",
        parameters: { type: "object", properties: {} },
        permissions: { autoExecute: true, requireMaster: true },
        action_fn: async () => "unused",
      }],
      executeActionFn: async () => ({
        result: "Restart signal sent.",
        permissions: {},
        afterResponse: () => {
          phases.push("after-response");
        },
      }),
    });

    const turn = createChatTurn({
      chatId: "conv-command-after-response",
      content: [{ type: "text", text: "!restart" }],
      io: {
        reply: async () => {
          phases.push("reply-start");
          await new Promise((resolve) => setTimeout(resolve, 10));
          phases.push("reply-done");
          return undefined;
        },
      },
    });

    await runner.handleMessage(turn.context);

    assert.deepEqual(phases, ["reply-start", "reply-done", "after-response"]);
  });

  it("stores raw group text, carries sender metadata, and omits the group-chat cue", async () => {
    await seedChat("conv-prompt-group", { enabled: true });
    await updateChatConfig("conv-prompt-group", (current) => ({
      ...current,
      harness: "codex",
      harness_config: {},
    }));

    /** @type {Message[] | null} */
    let seenMessages = null;
    /** @type {string | null} */
    let seenExternalInstructions = null;

    registerHarness("codex", () => createCodexHarness({
      startRun: async (input) => {
        seenMessages = input.messages;
        seenExternalInstructions = input.externalInstructions ?? null;
        return {
          abortController: new AbortController(),
          done: Promise.resolve({
            sessionId: null,
            result: {
              response: [{ type: "text", text: "ok" }],
              messages: input.messages,
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            },
          }),
        };
      },
    }));

    const turn = createChatTurn({
      chatId: "conv-prompt-group",
      senderName: "Alice",
      content: [{ type: "text", text: "hello" }],
      facts: { isGroup: true, addressedToBot: true, repliedToBot: false },
    });
    await handleMessage(turn.context);

    assert.ok(seenMessages, "Expected the harness to receive messages");
    const lastMessage = seenMessages.at(-1);
    assert.ok(lastMessage, "Expected a final user message");
    assert.equal(lastMessage.role, "user");
    if (lastMessage.role !== "user") {
      throw new Error("Expected the final message to be a user message");
    }
    assert.equal(lastMessage.senderName, "Alice");
    assert.deepEqual(lastMessage.content, [{ type: "text", text: "hello" }]);
    assert.equal(seenExternalInstructions, "");
  });
});
