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
/** @type {typeof import("../harnesses/index.js").registerHarnessDriver} */
let registerHarnessDriver;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);

  const { initStore } = await import("../store.js");
  store = await initStore(db);

  const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
  ({ registerHarnessDriver } = await import("../harnesses/index.js"));

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
  registerCodexHarness(createCodexHarness);
});

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(db, chatId, options);

/**
 * @param {() => AgentHarness} createHarness
 * @returns {void}
 */
function registerCodexHarness(createHarness) {
  registerHarnessDriver({
    name: "codex",
    displayName: "Codex",
    supportsInstances: true,
    createInstance: () => ({ harness: createHarness() }),
  });
}

/**
 * @param {{
 *   startRun?: (input: {
 *     messages: Message[],
 *     externalInstructions?: string,
 *     hooks?: AgentIOHooks,
 *   }) => Promise<{ abortController: AbortController, done: Promise<{ result: AgentResult }> }>,
 *   injectMessage?: AgentHarness["injectMessage"],
 * }} [options]
 * @returns {AgentHarness}
 */
function createCodexHarness(options = {}) {
  return {
    getName: () => "codex",
    getCapabilities: () => ({
      supportsResume: true,
      supportsCancel: true,
      supportsLiveInput: true,
      supportsApprovals: true,
      supportsWorkdir: true,
      supportsSandboxConfig: true,
      supportsModelSelection: true,
      supportsReasoningEffort: true,
      supportsSessionFork: true,
    }),
    async run(params) {
      const run = await options.startRun?.({
        messages: params.messages,
        externalInstructions: params.llmConfig.externalInstructions,
        hooks: params.hooks,
      });
      if (run) {
        return (await run.done).result;
      }
      return {
        response: [{ type: "text", text: "ok" }],
        messages: params.messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    },
    handleCommand: async () => false,
    injectMessage: options.injectMessage,
    listSlashCommands: () => [],
  };
}

/**
 * @returns {{ promise: Promise<void>, resolve: () => void }}
 */
function createDeferredVoid() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => {
    resolve = () => resolvePromise(undefined);
  });
  return { promise, resolve };
}

/**
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for condition");
}

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
    registerHarnessDriver({
      name: "adapter-lifecycle",
      supportsInstances: true,
      createInstance: () => ({
        harness: {
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
                assert.equal(input.chatId, "conv-adapter-session-start");
                assert.ok(input.messages?.some((message) => message.role === "user"));
                return {
                  response: [{ type: "text", text: "ok" }],
                  messages: input.messages ?? [],
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
        },
      }),
    });

    const turn = createChatTurn({
      chatId: "conv-adapter-session-start",
      content: [{ type: "text", text: "hello" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(phases, ["start:conv-adapter-session-start:model-a", "send"]);
  });

  it("uses semantic adapter turns and presents runtime events alongside returned content", async () => {
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
    registerHarnessDriver({
      name: "semantic-events",
      supportsInstances: true,
      createInstance: () => ({
        harness: {
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
              async startSession(input) {
                phases.push("start");
                return {
                  chatId: input.chatId,
                  harnessName: "semantic-events",
                  instanceId: "semantic-events",
                  continuationKey: "semantic-events:instance:semantic-events",
                  status: "ready",
                  resumeCursor: null,
                };
              },
              async sendTurn(input) {
                phases.push("semantic-send");
                assert.equal(input.chatId, "conv-semantic-events");
                assert.ok(input.messages?.some((message) => message.role === "user"));
                for (const subscriber of subscribers) {
                  await subscriber({
                    chatId: input.chatId,
                    turnId: "stale-turn",
                    providerInstanceId: "semantic-events",
                    type: "assistant.completed",
                    provider: "semantic-events",
                    text: "stale turn response",
                    contentType: "text",
                    responseMode: "replace",
                  });
                  await subscriber({
                    chatId: input.chatId,
                    turnId: input.turnId,
                    providerInstanceId: "other-instance",
                    type: "assistant.completed",
                    provider: "semantic-events",
                    text: "wrong instance response",
                    contentType: "text",
                    responseMode: "replace",
                  });
                  await subscriber({
                    chatId: input.chatId,
                    turnId: input.turnId,
                    providerInstanceId: "semantic-events",
                    type: "assistant.completed",
                    provider: "semantic-events",
                    text: "event response",
                    contentType: "text",
                    responseMode: "replace",
                  });
                }
                return {
                  response: [{ type: "text", text: "fallback response" }],
                  messages: input.messages ?? [],
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
        },
      }),
    });

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
    assert.deepEqual(replies, [
      [{ type: "markdown", text: "event response" }],
      [{ type: "text", text: "fallback response" }],
    ]);
    assert.ok(!replies.some((reply) => JSON.stringify(reply).includes("stale turn response")));
    assert.ok(!replies.some((reply) => JSON.stringify(reply).includes("wrong instance response")));
  });

  it("routes concurrent scoped provider runtime events only to their originating chat", async () => {
    const harnessName = "semantic-events-concurrent";
    const chatA = "conv-semantic-concurrent-a";
    const chatB = "conv-semantic-concurrent-b";
    await seedChat(chatA, { enabled: true });
    await seedChat(chatB, { enabled: true });
    await updateChatConfig(chatA, (current) => ({
      ...current,
      harness: harnessName,
      harness_config: {},
    }));
    await updateChatConfig(chatB, (current) => ({
      ...current,
      harness: harnessName,
      harness_config: {},
    }));

    /** @type {Array<({ type: string, provider: string, chatId?: string } & Record<string, unknown>) => void | Promise<void>>} */
    const subscribers = [];
    let startedTurns = 0;
    /** @type {() => void} */
    let releaseBothTurns = () => {};
    const bothTurnsStarted = new Promise((resolve) => {
      releaseBothTurns = resolve;
    });

    registerHarnessDriver({
      name: harnessName,
      supportsInstances: true,
      createInstance: () => ({
        harness: {
          getName: () => harnessName,
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
              async startSession(input) {
                return {
                  chatId: input.chatId,
                  harnessName,
                  instanceId: harnessName,
                  continuationKey: `${harnessName}:instance:${harnessName}`,
                  status: "ready",
                  resumeCursor: null,
                };
              },
              async sendTurn(input) {
                startedTurns += 1;
                if (startedTurns === 2) {
                  releaseBothTurns();
                } else {
                  await bothTurnsStarted;
                }
                for (const subscriber of subscribers) {
                  await subscriber({
                    chatId: input.chatId,
                    type: "assistant.completed",
                    provider: harnessName,
                    text: `event response for ${input.chatId}`,
                    contentType: "text",
                    responseMode: "replace",
                  });
                }
                return {
                  response: [{ type: "text", text: `fallback for ${input.chatId}` }],
                  messages: input.messages ?? [],
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
        },
      }),
    });

    const turnA = createChatTurn({
      chatId: chatA,
      content: [{ type: "text", text: "hello from A" }],
    });
    const turnB = createChatTurn({
      chatId: chatB,
      content: [{ type: "text", text: "hello from B" }],
    });

    await Promise.all([
      handleMessage(turnA.context),
      handleMessage(turnB.context),
    ]);

    assert.ok(
      turnA.responses.some((response) => response.text === `event response for ${chatA}`),
      `Expected chat A to receive its own event, got ${JSON.stringify(turnA.responses)}`,
    );
    assert.ok(
      !turnA.responses.some((response) => response.text === `event response for ${chatB}`),
      `Expected chat A not to receive chat B's event, got ${JSON.stringify(turnA.responses)}`,
    );
    assert.ok(
      turnB.responses.some((response) => response.text === `event response for ${chatB}`),
      `Expected chat B to receive its own event, got ${JSON.stringify(turnB.responses)}`,
    );
    assert.ok(
      !turnB.responses.some((response) => response.text === `event response for ${chatA}`),
      `Expected chat B not to receive chat A's event, got ${JSON.stringify(turnB.responses)}`,
    );
  });

  it("presents Codex semantic adapter Read and Shell progress through the conversation runner", async () => {
    await seedChat("conv-codex-runtime-progress", { enabled: true });
    await updateChatConfig("conv-codex-runtime-progress", (current) => ({
      ...current,
      harness: "codex",
      harness_config: {},
    }));

    registerCodexHarness(() => createCodexHarness({
      startRun: async (input) => {
        const readCommand = "sed -n '1,20p' src/app.js";
        await input.hooks?.onFileRead?.({
          command: readCommand,
          paths: ["src/app.js"],
        });
        await input.hooks?.onCommand?.({
          command: readCommand,
          status: "completed",
          output: "  1→ const value = 1;",
        });
        await input.hooks?.onCommand?.({
          command: "pnpm type-check",
          status: "started",
        });
        await input.hooks?.onLlmResponse?.("done");
        return {
          abortController: new AbortController(),
          done: Promise.resolve({
            sessionId: null,
            result: {
              response: [{ type: "text", text: "done" }],
              messages: input.messages,
              usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
            },
          }),
        };
      },
    }));

    const turn = createChatTurn({
      chatId: "conv-codex-runtime-progress",
      content: [{ type: "text", text: "hello" }],
    });
    await handleMessage(turn.context);

    const progressTexts = turn.responses
      .filter((response) => response.source === "plain")
      .map((response) => response.text);
    assert.ok(
      progressTexts.some((text) => text.includes("*Read*  `src/app.js`")),
      `expected Read progress, got: ${JSON.stringify(progressTexts)}`,
    );
    assert.ok(
      progressTexts.some((text) => text.includes("*Shell*  `pnpm type-check`")),
      `expected Shell progress, got: ${JSON.stringify(progressTexts)}`,
    );
  });

  it("injects into the active harness and defers a selected instance change until the turn finishes", async () => {
    const chatId = "conv-harness-switch-mid-turn";
    const harnessName = "adapter-lifecycle";
    await seedChat(chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      harness_config: {
        activeHarnessInstances: { [harnessName]: "work" },
        harnessInstances: {
          [harnessName]: {
            work: { model: "model-a" },
            personal: { model: "model-b" },
          },
        },
      },
    }));

    const releaseFirstRun = createDeferredVoid();
    /** @type {string[]} */
    const phases = [];
    /** @type {string[]} */
    const injectedTexts = [];
    registerHarnessDriver({
      name: harnessName,
      supportsInstances: true,
      createInstance: ({ instanceId }) => {
        phases.push(`create:${instanceId}`);
        const harness = createCodexHarness({
          startRun: async (input) => ({
            abortController: new AbortController(),
            done: (async () => {
              phases.push(`run:${instanceId}`);
              if (instanceId === "work") {
                await releaseFirstRun.promise;
              }
              return {
                result: {
                  response: [{ type: "text", text: `ok:${instanceId}` }],
                  messages: input.messages,
                  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
                },
              };
            })(),
          }),
          injectMessage: (_chatId, text) => {
            injectedTexts.push(`${instanceId}:${text}`);
            return true;
          },
        });
        return {
          harness,
          dispose: async () => {
            phases.push(`dispose:${instanceId}`);
          },
        };
      },
    });

    const firstTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "first" }],
    });
    const firstHandled = handleMessage(firstTurn.context);
    await waitUntil(() => phases.includes("run:work"));

    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      harness_config: {
        activeHarnessInstances: { [harnessName]: "personal" },
        harnessInstances: {
          [harnessName]: {
            work: { model: "model-a" },
            personal: { model: "model-b" },
          },
        },
      },
    }));

    const secondTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "second" }],
    });
    await handleMessage(secondTurn.context);

    assert.deepEqual(phases, ["create:work", "run:work"]);
    assert.deepEqual(injectedTexts, ["work:second"]);

    releaseFirstRun.resolve();
    await firstHandled;
    assert.ok(!phases.includes("create:personal"), `did not expect personal instance before a new post-turn message, got ${JSON.stringify(phases)}`);

    const thirdTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "third" }],
    });
    await handleMessage(thirdTurn.context);
    await waitUntil(() => phases.includes("run:personal"));

    assert.ok(phases.includes("create:personal"), `expected personal instance after a post-turn message, got ${JSON.stringify(phases)}`);
    assert.ok(phases.includes("run:personal"), `expected post-turn message to run on personal instance, got ${JSON.stringify(phases)}`);
    assert.ok(phases.indexOf("create:personal") > phases.indexOf("run:work"));
  });

  it("injects mid-turn messages through the active semantic adapter", async () => {
    const chatId = "conv-adapter-live-input";
    const harnessName = "adapter-live-input";
    await seedChat(chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      harness_config: {},
    }));

    const releaseFirstRun = createDeferredVoid();
    /** @type {string[]} */
    const phases = [];
    /** @type {string[]} */
    const injectedTexts = [];
    registerHarnessDriver({
      name: harnessName,
      supportsInstances: true,
      createInstance: ({ instanceId, continuationKey }) => ({
        harness: {
          getName: () => harnessName,
          getCapabilities: () => ({
            supportsResume: true,
            supportsCancel: true,
            supportsLiveInput: true,
            supportsApprovals: false,
            supportsWorkdir: true,
            supportsSandboxConfig: false,
            supportsModelSelection: false,
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
              async startSession(input) {
                phases.push("start");
                return {
                  chatId: input.chatId,
                  harnessName,
                  instanceId,
                  continuationKey,
                  status: "ready",
                  resumeCursor: input.resumeCursor ?? null,
                };
              },
              async sendTurn(input) {
                phases.push("send");
                assert.equal(input.chatId, chatId);
                await releaseFirstRun.promise;
                return {
                  response: [{ type: "text", text: "ok" }],
                  messages: input.messages ?? [],
                  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
                };
              },
              interruptTurn: async () => false,
              injectMessage: async (_chatId, text) => {
                phases.push("inject");
                injectedTexts.push(text);
                return true;
              },
              stopSession: async () => false,
              listSessions: () => [],
              readThread: async () => null,
              rollbackThread: async () => null,
              streamEvents: {
                async *[Symbol.asyncIterator]() {},
              },
              subscribeEvents: () => () => {},
            };
          },
        },
      }),
    });

    const firstTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "first" }],
    });
    const firstHandled = handleMessage(firstTurn.context);
    await waitUntil(() => phases.includes("send"));

    const secondTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "second" }],
    });
    await handleMessage(secondTurn.context);

    assert.deepEqual(injectedTexts, ["second"]);
    assert.deepEqual(phases, ["start", "send", "inject"]);

    releaseFirstRun.resolve();
    await firstHandled;
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

  it("queues incoming messages without processing while restart is waiting", async () => {
    const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
    /** @type {ChatTurn[]} */
    const queuedTurns = [];
    const runner = createConversationRunner({
      store,
      llmClient: /** @type {LlmClient} */ ({}),
      getActionsFn: async () => {
        throw new Error("Restart-waiting messages should not load actions");
      },
      executeActionFn: async () => {
        throw new Error("Restart-waiting messages should not execute actions");
      },
      restartGate: {
        isWaiting: () => true,
        beginWaiting: () => {},
        queueTurn: (turn) => {
          queuedTurns.push(turn);
        },
        drainQueuedTurns: () => [],
        reset: () => {},
      },
    });

    const turn = createChatTurn({
      chatId: "conv-restart-waiting",
      content: [{ type: "text", text: "run something new" }],
    });
    await runner.handleMessage(turn.context);

    assert.equal(queuedTurns.length, 1);
    assert.equal(queuedTurns[0]?.chatId, "conv-restart-waiting");
    assert.deepEqual(turn.responses, []);
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

    registerCodexHarness(() => createCodexHarness({
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
