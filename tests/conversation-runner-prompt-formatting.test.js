import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";

import { createChatTurn, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";
import { updateChatConfig } from "../chat-config.js";

const execFileAsync = promisify(execFile);

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
  });

  handleMessage = runner.handleMessage;
});

afterEach(() => {
  registerCodexHarness(createCodexHarness);
});

/** @param {string} chatId @param {{enabled?: boolean, systemPrompt?: string | null, model?: string | null}} [options] */
const seedChat = (chatId, options) => seedChat_(db, chatId, options);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

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

describe("/diff slash command", () => {
  it("renders the current git diff as file-change events", async () => {
    const chatId = "slash-diff-chat";
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "runner-slash-diff-"));
    try {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test User"]);
      await fs.writeFile(path.join(repo, "app.js"), "const value = 1;\n", "utf8");
      await git(repo, ["add", "app.js"]);
      await git(repo, ["commit", "-m", "initial"]);
      await fs.writeFile(path.join(repo, "app.js"), "const value = 2;\n", "utf8");

      await seedChat(chatId, { enabled: true });
      await updateChatConfig(chatId, (current) => ({
        ...current,
        harness_cwd: repo,
      }));

      /** @type {OutboundEvent[]} */
      const events = [];
      const { context } = createChatTurn({
        chatId,
        chatName: "Diff Repo",
        content: [{ type: "text", text: "/diff" }],
        io: {
          reply: async (event) => {
            events.push(event);
            return undefined;
          },
        },
      });

      await handleMessage(context);

      assert.equal(events.length, 1);
      assert.equal(events[0]?.kind, "file_change");
      assert.equal(events[0]?.kind === "file_change" ? events[0].path : "", "app.js");
      assert.match(events[0]?.kind === "file_change" ? events[0].diff ?? "" : "", /\+const value = 2;/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("passes a commit-depth argument through /diff", async () => {
    const chatId = "slash-diff-depth-chat";
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "runner-slash-diff-depth-"));
    try {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test User"]);
      await fs.writeFile(path.join(repo, "app.js"), "const value = 1;\n", "utf8");
      await git(repo, ["add", "app.js"]);
      await git(repo, ["commit", "-m", "initial"]);
      await fs.writeFile(path.join(repo, "app.js"), "const value = 2;\n", "utf8");
      await git(repo, ["commit", "-am", "second"]);
      await fs.writeFile(path.join(repo, "app.js"), "const value = 3;\n", "utf8");

      await seedChat(chatId, { enabled: true });
      await updateChatConfig(chatId, (current) => ({
        ...current,
        harness_cwd: repo,
      }));

      /** @type {OutboundEvent[]} */
      const events = [];
      const { context } = createChatTurn({
        chatId,
        chatName: "Diff Repo",
        content: [{ type: "text", text: "/diff 1" }],
        io: {
          reply: async (event) => {
            events.push(event);
            return undefined;
          },
        },
      });

      await handleMessage(context);

      assert.equal(events.length, 1);
      assert.equal(events[0]?.kind, "file_change");
      assert.match(events[0]?.kind === "file_change" ? events[0].diff ?? "" : "", /-const value = 1;/);
      assert.match(events[0]?.kind === "file_change" ? events[0].diff ?? "" : "", /\+const value = 3;/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

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
    async run() {
      assert.fail("codex test harness should use the semantic adapter");
    },
    handleCommand: async () => false,
    listSlashCommands: () => [],
    createAdapter({ name, instanceId, continuationKey }) {
      /** @type {Map<string, HarnessRuntimeSession>} */
      const sessions = new Map();
      return {
        async startSession(input) {
          const session = {
            chatId: input.chatId,
            harnessName: name,
            instanceId,
            continuationKey,
            status: "ready",
            workdir: input.runConfig?.workdir ?? null,
            model: input.runConfig?.model ?? null,
            resumeCursor: input.resumeCursor ?? null,
          };
          sessions.set(input.chatId, /** @type {HarnessRuntimeSession} */ (session));
          return /** @type {HarnessRuntimeSession} */ (session);
        },
        async sendTurn(input) {
          const run = await options.startRun?.({
            messages: input.messages ?? [],
            externalInstructions: input.externalInstructions,
            hooks: input.hooks,
          });
          if (run) {
            return (await run.done).result;
          }
          return {
            response: [{ type: "text", text: "ok" }],
            messages: input.messages ?? [],
            usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
          };
        },
        interruptTurn: async () => false,
        respondToRequest: async () => false,
        respondToUserInput: async () => false,
        injectMessage: async (chatId, text) => !!(await options.injectMessage?.(chatId, text)),
        stopSession: async (chatId) => {
          sessions.delete(typeof chatId === "string" ? chatId : chatId.id);
          return true;
        },
        hasSession: (chatId) => sessions.has(typeof chatId === "string" ? chatId : chatId.id),
        stopAll: async () => {
          sessions.clear();
        },
        listSessions: () => [...sessions.values()],
        rollbackThread: async () => null,
        streamEvents: {
          async *[Symbol.asyncIterator]() {},
        },
        subscribeEvents: () => () => {},
      };
    },
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

  it("passes Codex compact progress through the conversation runner as semantic activity", async () => {
    await seedChat("conv-codex-runtime-progress", { enabled: true });
    await updateChatConfig("conv-codex-runtime-progress", (current) => ({
      ...current,
      harness: "codex",
      harness_config: {},
    }));

    registerCodexHarness(() => createCodexHarness({
      startRun: async (input) => {
        const readCommand = "sed -n '1,20p' src/app.js";
        await input.hooks?.onRuntimeEvent?.({
          type: "command.completed",
          provider: "codex",
          command: {
            command: readCommand,
            status: "completed",
            output: "  1→ const value = 1;",
          },
        });
        await input.hooks?.onRuntimeEvent?.({
          type: "command.started",
          provider: "codex",
          command: {
            command: "pnpm type-check",
            status: "started",
          },
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
      progressTexts.some((text) => text.includes("\"type\":\"command.started\"") && text.includes("\"command\":\"pnpm type-check\"")),
      `expected command progress activity, got: ${JSON.stringify(progressTexts)}`,
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

  it("starts a follow-up run when media live-input conversion loses the active-run race", async () => {
    const chatId = "conv-live-input-media-race";
    const harnessName = "adapter-live-input-media-race";
    await seedChat(chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      media_to_text_models: { audio: "audio/model" },
      harness_config: {},
    }));

    const releaseFirstRun = createDeferredVoid();
    /** @type {string[]} */
    const phases = [];
    /** @type {string[]} */
    const injectedTexts = [];
    let runCount = 0;
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
                runCount += 1;
                phases.push(`run:${runCount}`);
                if (runCount === 1) {
                  await releaseFirstRun.promise;
                }
                return {
                  response: [{ type: "text", text: `ok:${runCount}` }],
                  messages: input.messages ?? [],
                  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
                };
              },
              interruptTurn: async () => false,
              injectMessage: async (_chatId, text) => {
                injectedTexts.push(text);
                return false;
              },
              stopSession: async () => false,
              listSessions: () => [],
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

    const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
    const runner = createConversationRunner({
      store,
      llmClient: /** @type {LlmClient} */ ({
        chat: {
          completions: {
            create: async () => {
              phases.push("transcribe");
              releaseFirstRun.resolve();
              await new Promise((resolve) => setTimeout(resolve, 10));
              return {
                choices: [{ message: { content: "spoken follow-up" } }],
              };
            },
          },
        },
      }),
    });

    const firstTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "first" }],
    });
    const firstHandled = runner.handleMessage(firstTurn.context);
    await waitUntil(() => phases.includes("run:1"));

    const secondTurn = createChatTurn({
      chatId,
      content: [{
        type: "audio",
        data: Buffer.from("fake audio bytes for stuck replay").toString("base64"),
        encoding: "base64",
        mime_type: "audio/mp3",
      }],
    });
    await runner.handleMessage(secondTurn.context);
    await firstHandled;

    assert.deepEqual(injectedTexts, []);
    assert.deepEqual(phases, ["run:1", "transcribe", "run:2"]);
    assert.deepEqual(secondTurn.responses.map((response) => response.text), [
      "Transcribing audio...",
      "Transcribed",
      "ok:2",
    ]);
  });

  it("shows an inspectable transcribing status for audio live input", async () => {
    const chatId = "conv-live-input-audio-transcribing-status";
    const harnessName = "adapter-live-input-audio-transcribing-status";
    await seedChat(chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      media_to_text_models: { audio: "audio/model" },
      harness_config: {},
    }));

    const releaseFirstRun = createDeferredVoid();
    /** @type {string[]} */
    const injectedTexts = [];
    /** @type {string[]} */
    const phases = [];
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
                phases.push("run:1");
                await releaseFirstRun.promise;
                return {
                  response: [{ type: "text", text: "ok" }],
                  messages: input.messages ?? [],
                  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
                };
              },
              interruptTurn: async () => false,
              injectMessage: async (_chatId, text) => {
                injectedTexts.push(text);
                return true;
              },
              stopSession: async () => false,
              listSessions: () => [],
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

    const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
    const runner = createConversationRunner({
      store,
      llmClient: /** @type {LlmClient} */ ({
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: "The speaker says check deploy status." } }],
            }),
          },
        },
      }),
    });

    const firstTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "first" }],
    });
    const firstHandled = runner.handleMessage(firstTurn.context);
    await waitUntil(() => phases.includes("run:1"));

    /** @type {MessageInspectState[]} */
    const inspectStates = [];
    const secondTurn = createChatTurn({
      chatId,
      content: [{
        type: "audio",
        data: Buffer.from("fake audio bytes for inspectable status").toString("base64"),
        encoding: "base64",
        mime_type: "audio/mp3",
      }],
    });
    secondTurn.context.io.reply = async (event) => {
      assert.equal(event.kind, "content");
      assert.equal(event.source, "plain");
      const content = event.content;
      assert.equal(typeof content, "string");
      secondTurn.responses.push({ type: "reply", text: content, source: event.source });
      return {
        update: async (update) => {
          assert.equal(update.kind, "text");
          secondTurn.responses.push({ type: "edit", text: update.text, source: event.source });
        },
        setInspect: (inspect) => {
          if (inspect) inspectStates.push(inspect);
        },
      };
    };

    await runner.handleMessage(secondTurn.context);
    releaseFirstRun.resolve();
    await firstHandled;

    assert.equal(injectedTexts.length, 1);
    assert.ok(injectedTexts[0]?.includes("The speaker says check deploy status."), injectedTexts[0]);
    assert.equal(injectedTexts[0]?.includes("[Audio description:"), false, injectedTexts[0]);
    assert.ok(injectedTexts[0]?.includes("Media file available in this request:"), injectedTexts[0]);
    assert.deepEqual(secondTurn.responses.map((response) => response.text), [
      "Transcribing audio...",
      "Transcribed",
    ]);
    assert.deepEqual(inspectStates, [{
      kind: "text",
      text: "The speaker says check deploy status.",
    }]);
  });

  it("replays failed live input when the active harness turn stays pending", async () => {
    const chatId = "conv-live-input-stuck-replay";
    const harnessName = "adapter-live-input-stuck-replay";
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
    let runCount = 0;
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
                runCount += 1;
                phases.push(`run:${runCount}`);
                if (runCount === 1) {
                  await releaseFirstRun.promise;
                }
                return {
                  response: [{ type: "text", text: `ok:${runCount}` }],
                  messages: input.messages ?? [],
                  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
                };
              },
              interruptTurn: async () => {
                phases.push("interrupt");
                releaseFirstRun.resolve();
                return true;
              },
              injectMessage: async (_chatId, text) => {
                phases.push("inject:false");
                injectedTexts.push(text);
                return false;
              },
              stopSession: async () => false,
              listSessions: () => [],
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

    const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
    const runner = createConversationRunner({
      store,
      llmClient: /** @type {LlmClient} */ ({}),
      liveInputFallbackDelayMs: 5,
    });

    const firstTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "first" }],
    });
    const firstHandled = runner.handleMessage(firstTurn.context);
    await waitUntil(() => phases.includes("run:1"));

    const secondTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "ready" }],
    });
    await runner.handleMessage(secondTurn.context);
    await waitUntil(() => phases.includes("run:2"));

    assert.deepEqual(injectedTexts, ["ready"]);
    assert.deepEqual(phases, ["run:1", "inject:false", "interrupt", "run:2"]);
    assert.deepEqual(secondTurn.responses.map((response) => response.text), ["ok:2"]);

    releaseFirstRun.resolve();
    await firstHandled;
  });

  it("replays failed media live input using the prebuilt transcript", async () => {
    const chatId = "conv-live-input-media-stuck-replay";
    const harnessName = "adapter-live-input-media-stuck-replay";
    await seedChat(chatId, { enabled: true });
    await updateChatConfig(chatId, (current) => ({
      ...current,
      harness: harnessName,
      media_to_text_models: { audio: "audio/model" },
      harness_config: {},
    }));

    const releaseFirstRun = createDeferredVoid();
    /** @type {string[]} */
    const phases = [];
    /** @type {string[]} */
    const inputs = [];
    let runCount = 0;
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
                runCount += 1;
                phases.push(`run:${runCount}`);
                inputs.push(input.input ?? "");
                if (runCount === 1) {
                  await releaseFirstRun.promise;
                }
                return {
                  response: [{ type: "text", text: `ok:${runCount}` }],
                  messages: input.messages ?? [],
                  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
                };
              },
              interruptTurn: async () => {
                phases.push("interrupt");
                releaseFirstRun.resolve();
                return true;
              },
              injectMessage: async () => {
                phases.push("inject:false");
                return false;
              },
              stopSession: async () => false,
              listSessions: () => [],
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

    const { createConversationRunner } = await import("../conversation/create-conversation-runner.js");
    const runner = createConversationRunner({
      store,
      llmClient: /** @type {LlmClient} */ ({
        chat: {
          completions: {
            create: async () => {
              phases.push("transcribe");
              return {
                choices: [{ message: { content: "spoken replay" } }],
              };
            },
          },
        },
      }),
      liveInputFallbackDelayMs: 5,
    });

    const firstTurn = createChatTurn({
      chatId,
      content: [{ type: "text", text: "first" }],
    });
    const firstHandled = runner.handleMessage(firstTurn.context);
    await waitUntil(() => phases.includes("run:1"));

    const secondTurn = createChatTurn({
      chatId,
      content: [{
        type: "audio",
        data: Buffer.from("fake audio bytes").toString("base64"),
        encoding: "base64",
        mime_type: "audio/mp3",
      }],
    });
    await runner.handleMessage(secondTurn.context);
    await waitUntil(() => phases.includes("run:2"));

    assert.deepEqual(phases, ["run:1", "transcribe", "inject:false", "interrupt", "run:2"]);
    assert.match(inputs[1] ?? "", /spoken replay/);
    assert.deepEqual(secondTurn.responses.map((response) => response.text), [
      "Transcribing audio...",
      "Transcribed",
      "ok:2",
    ]);

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
      restartCommandHandler: async () => ({
        result: "Restart signal sent.",
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
