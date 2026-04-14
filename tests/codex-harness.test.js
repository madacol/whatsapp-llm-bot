import { afterEach, describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { ACTION_REQUESTS_ENV_VAR, writeQueuedActionRequest } from "../action-request-runtime.js";
import { resolveMediaPath } from "../attachment-paths.js";
import { setDb } from "../db.js";
import { createMockLlmServer, createTestDb, seedChat, withModelsCache } from "./helpers.js";
import {
  buildCodexThreadOptions,
  createCodexHarness,
} from "../harnesses/codex.js";
import { createLlmClient } from "../llm.js";
import { writeMedia } from "../media-store.js";

const TEST_CODEX_MODELS = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5-codex", label: "GPT-5 Codex" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
];

/**
 * @param {OutboundEvent} event
 * @returns {string}
 */
function getReplyText(event) {
  assert.equal(event.kind, "content");
  return typeof event.content === "string" ? event.content : JSON.stringify(event.content);
}

before(async () => {
  const db = await createTestDb();
  setDb("./pgdata/root", db);
});

/** @type {Set<string>} */
const createdMediaPaths = new Set();

afterEach(async () => {
  await Promise.all(
    [...createdMediaPaths].map(async (mediaPath) => {
      await rm(resolveMediaPath(mediaPath), { force: true });
    }),
  );
  createdMediaPaths.clear();
});

describe("createCodexHarness", () => {
  it("exposes the unified harness contract", () => {
    const harness = createCodexHarness();

    assert.equal(harness.getName(), "codex");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.equal(typeof harness.listSlashCommands, "function");
    assert.deepEqual(harness.getCapabilities(), {
      supportsResume: true,
      supportsCancel: true,
      supportsLiveInput: true,
      supportsApprovals: true,
      supportsWorkdir: true,
      supportsSandboxConfig: true,
      supportsModelSelection: true,
      supportsReasoningEffort: false,
      supportsSessionFork: true,
    });
    assert.deepEqual(harness.listSlashCommands(), [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      { name: "fork", description: "Fork the current Codex thread" },
      { name: "back", description: "Return to the previous Codex fork parent" },
      { name: "model", description: "Choose or set the Codex model" },
      { name: "sandbox", description: "Alias of /permissions" },
      { name: "permissions", description: "Show or set the Codex permissions mode" },
      { name: "approval", description: "Show or set the Codex approval policy" },
    ]);
  });

  it("handles codex-owned model command", async () => {
    const db = await createTestDb();
    await seedChat(db, "codex-chat-1", { enabled: true });
    const harness = createCodexHarness({
      getAvailableModels: async () => TEST_CODEX_MODELS,
    });
    /** @type {string[]} */
    const replies = [];
    const handled = await harness.handleCommand({
      chatId: "codex-chat-1",
      command: "model gpt-5.4",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-chat-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
    });

    assert.equal(handled, true);
    assert.ok(replies[0]?.includes("Codex model set"));
  });

  it("forks the active Codex session and switches the saved session id", async () => {
    const harness = createCodexHarness({
      getAvailableModels: async () => TEST_CODEX_MODELS,
      readThread: async (threadId, includeTurns) => {
        assert.equal(threadId, "sess-parent");
        assert.equal(includeTurns, true);
        return {
          thread: {
            preview: "Debugging sync latency",
            turns: [
              {
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: [{ type: "text", text: "Debugging sync latency", text_elements: [] }],
                  },
                ],
              },
            ],
          },
        };
      },
      forkThread: async (threadId) => {
        assert.equal(threadId, "sess-parent");
        return {
          thread: { id: "sess-forked" },
        };
      },
    });
    /** @type {Array<{ chatId: string, session: HarnessSessionRef | null }>} */
    const savedSessions = [];
    /** @type {Array<{ chatId: string, entry: HarnessForkStackEntry }>} */
    const pushedEntries = [];
    /** @type {string[]} */
    const replies = [];

    const handled = await harness.handleCommand({
      chatId: "codex-fork-1",
      chatInfo: /** @type {import("../store.js").ChatRow} */ ({
        chat_id: "codex-fork-1",
        harness_session_id: "sess-parent",
        harness_session_kind: "codex",
      }),
      command: "fork",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-fork-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
      sessionForkControl: {
        save: async (chatId, session) => {
          savedSessions.push({ chatId, session });
        },
        push: async (chatId, entry) => {
          pushedEntries.push({ chatId, entry });
        },
        pop: async () => null,
      },
    });

    assert.equal(handled, true);
    assert.deepEqual(pushedEntries, [{
      chatId: "codex-fork-1",
      entry: { id: "sess-parent", kind: "codex", label: "Debugging sync latency" },
    }]);
    assert.deepEqual(savedSessions, [{
      chatId: "codex-fork-1",
      session: { id: "sess-forked", kind: "codex" },
    }]);
    assert.ok(replies[0]?.includes("Forked"));
    assert.ok(replies[0]?.includes("Debugging sync latency"));
  });

  it("returns to the previous Codex fork parent on back", async () => {
    const harness = createCodexHarness({
      getAvailableModels: async () => TEST_CODEX_MODELS,
    });
    /** @type {Array<{ chatId: string, session: HarnessSessionRef | null }>} */
    const savedSessions = [];
    /** @type {string[]} */
    const replies = [];

    const handled = await harness.handleCommand({
      chatId: "codex-fork-2",
      command: "back",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-fork-2",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
      sessionForkControl: {
        save: async (chatId, session) => {
          savedSessions.push({ chatId, session });
        },
        push: async () => undefined,
        pop: async () => ({ id: "sess-parent", kind: "codex", label: "Parent thread" }),
      },
    });

    assert.equal(handled, true);
    assert.deepEqual(savedSessions, [{
      chatId: "codex-fork-2",
      session: { id: "sess-parent", kind: "codex" },
    }]);
    assert.ok(replies[0]?.includes("Returned"));
    assert.ok(replies[0]?.includes("Parent thread"));
  });

  it("refuses to fork when the current Codex thread has no completed turns", async () => {
    const harness = createCodexHarness({
      getAvailableModels: async () => TEST_CODEX_MODELS,
      readThread: async () => ({
        thread: {
          preview: "",
          turns: [],
        },
      }),
      forkThread: async () => {
        throw new Error("forkThread should not be called");
      },
    });
    /** @type {string[]} */
    const replies = [];

    const handled = await harness.handleCommand({
      chatId: "codex-fork-3",
      chatInfo: /** @type {import("../store.js").ChatRow} */ ({
        chat_id: "codex-fork-3",
        harness_session_id: "sess-empty",
        harness_session_kind: "codex",
      }),
      command: "fork",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-fork-3",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
      sessionForkControl: {
        save: async () => undefined,
        push: async () => undefined,
        pop: async () => null,
      },
    });

    assert.equal(handled, true);
    assert.ok(replies[0]?.includes("Can't fork yet"));
  });

  it("lets the user choose from valid codex model options when no model is provided", async () => {
    const db = await createTestDb();
    await seedChat(db, "codex-chat-2", { enabled: true });
    const harness = createCodexHarness({
      getAvailableModels: async () => TEST_CODEX_MODELS,
    });
    /** @type {string[]} */
    const replies = [];
    /** @type {SelectOption[] | null} */
    let selectedOptions = null;

    const handled = await harness.handleCommand({
      chatId: "codex-chat-2",
      command: "model",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-chat-2",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async (_question, options) => {
          selectedOptions = options;
          return "gpt-5.3-codex";
        },
        confirm: async () => true,
      }),
    });

    assert.equal(handled, true);
    assert.deepEqual(selectedOptions, [
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      { id: "gpt-5-codex", label: "GPT-5 Codex" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "off", label: "Default" },
    ]);
    assert.ok(replies.at(-1)?.includes("Codex model: `gpt-5.3-codex`"));
  });

  it("handles permissions command through a selector and defaults to workspace-write", async () => {
    const db = await createTestDb();
    await seedChat(db, "codex-chat-3", { enabled: true });
    const harness = createCodexHarness({
      getAvailableModels: async () => TEST_CODEX_MODELS,
    });
    /** @type {string[]} */
    const replies = [];
    /** @type {SelectOption[] | null} */
    let selectedOptions = null;

    const handled = await harness.handleCommand({
      chatId: "codex-chat-3",
      command: "permissions",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "codex-chat-3",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async (event) => {
          replies.push(getReplyText(event));
          return undefined;
        },
        reactToMessage: async () => {},
        select: async (_question, options) => {
          selectedOptions = options;
          return "danger-full-access";
        },
        confirm: async () => true,
      }),
    });

    assert.equal(handled, true);
    assert.deepEqual(selectedOptions, [
      { id: "workspace-write", label: "Workspace Write" },
      { id: "read-only", label: "Read Only" },
      { id: "danger-full-access", label: "Full Access" },
    ]);
    assert.ok(replies.at(-1)?.includes("Codex permissions: `danger-full-access`"));
  });

  it("clears the saved Codex session and returns an SDK error response when a resumed run fails", async () => {
    /** @type {Array<{ chatId: string, session: HarnessSessionRef | null }>} */
    const savedSessions = [];
    /** @type {string[]} */
    const errors = [];
    const harness = createCodexHarness({
      startRun: async () => ({
        abortController: new AbortController(),
        done: Promise.reject(new Error("Codex Exec exited with code 1: Reading prompt from stdin...")),
      }),
    });

    const result = await harness.run({
      session: {
        chatId: "codex-chat-4",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-4",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: { id: "sess-stale", kind: "codex" },
        saveHarnessSession: async (chatId, session) => {
          savedSessions.push({ chatId, session });
        },
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {
        onToolError: async (message) => {
          errors.push(message);
        },
      },
      runConfig: undefined,
    });

    assert.deepEqual(savedSessions, [{ chatId: "codex-chat-4", session: null }]);
    assert.deepEqual(errors, ["Codex Exec exited with code 1: Reading prompt from stdin..."]);
    assert.deepEqual(result.response, [{
      type: "text",
      text: "SDK error: Codex Exec exited with code 1: Reading prompt from stdin...",
    }]);
  });

  it("ignores a stale Claude model in the shared chat row before starting Codex", async () => {
    const db = await createTestDb();
    await seedChat(db, "codex-chat-invalid-model", { enabled: true });
    await db.sql`
      UPDATE chats
      SET harness = 'codex',
          harness_config = '{"model":"sonnet","sandboxMode":"danger-full-access"}'::jsonb
      WHERE chat_id = 'codex-chat-invalid-model'
    `;

    /** @type {HarnessRunConfig | undefined} */
    let seenRunConfig;
    const harness = createCodexHarness({
      getAvailableModels: async () => TEST_CODEX_MODELS,
      startRun: async (input) => {
        seenRunConfig = input.runConfig;
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
    });

    const result = await harness.run({
      session: {
        chatId: "codex-chat-invalid-model",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-invalid-model",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: null,
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {},
      runConfig: {
        model: "sonnet",
        sandboxMode: "danger-full-access",
      },
    });

    assert.equal(seenRunConfig?.model, undefined);
    assert.equal(seenRunConfig?.sandboxMode, "danger-full-access");
    assert.deepEqual(result.response, [{ type: "text", text: "ok" }]);

    const { rows: [chat] } = await db.sql`
      SELECT harness_config
      FROM chats
      WHERE chat_id = 'codex-chat-invalid-model'
    `;
    assert.deepEqual(chat.harness_config, {
      codex: {
        sandboxMode: "danger-full-access",
      },
      "claude-agent-sdk": {
        model: "sonnet",
      },
    });
  });

  it("injects follow-up text into an active Codex run when the transport supports steering", async () => {
    /** @type {string[]} */
    const steerCalls = [];
    /** @type {(value: { sessionId: string | null, result: AgentResult }) => void} */
    let resolveDone = () => {};

    const harness = createCodexHarness({
      startRun: async (input) => ({
        abortController: new AbortController(),
        steer: async (text) => {
          steerCalls.push(text);
          return true;
        },
        interrupt: async () => true,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      }),
    });

    const runPromise = harness.run({
      session: {
        chatId: "codex-chat-live-input",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-live-input",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: { id: "sess-live", kind: "codex" },
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {},
      runConfig: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const injected = await harness.injectMessage?.("codex-chat-live-input", "Actually check the failing test first");
    assert.equal(injected, true);
    assert.deepEqual(steerCalls, ["Actually check the failing test first"]);

    resolveDone({
      sessionId: "sess-live",
      result: {
        response: [{ type: "text", text: "ok" }],
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      },
    });
    await runPromise;
  });

  it("includes canonical media paths in the Codex prompt for media-only turns", async () => {
    /** @type {string | null} */
    let seenPrompt = null;
    const harness = createCodexHarness({
      startRun: async (input) => {
        seenPrompt = input.prompt;
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
    });

    const mediaPath = `${"a".repeat(64)}.jpg`;
    const result = await harness.run({
      session: {
        chatId: "codex-chat-media-path",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-media-path",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: null,
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          listTools: () => [],
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{
        role: "user",
        content: [{
          type: "image",
          path: mediaPath,
          mime_type: "image/jpeg",
        }],
      }],
      hooks: {},
      runConfig: undefined,
    });

    assert.equal(seenPrompt, `Media file available in this request:\n- ${mediaPath}`);
    assert.deepEqual(result.response, [{ type: "text", text: "ok" }]);
  });

  it("keeps private-chat Codex prompts unchanged", async () => {
    /** @type {string | null} */
    let seenPrompt = null;
    const harness = createCodexHarness({
      startRun: async (input) => {
        seenPrompt = input.prompt;
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
    });

    await harness.run({
      session: {
        chatId: "codex-chat-private-prefix",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-private-prefix",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: null,
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          listTools: () => [],
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello",
        }],
      }],
      hooks: {},
      runConfig: undefined,
    });

    assert.equal(seenPrompt, "hello");
  });

  it("ignores sender metadata when building Codex prompts", async () => {
    /** @type {string | null} */
    let seenPrompt = null;
    const harness = createCodexHarness({
      startRun: async (input) => {
        seenPrompt = input.prompt;
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
    });

    await harness.run({
      session: {
        chatId: "codex-chat-group-prefix",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-group-prefix",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: null,
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          listTools: () => [],
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{
        role: "user",
        senderName: "Marco D'Agostini",
        content: [{
          type: "text",
          text: "hello",
        }],
      }],
      hooks: {},
      runConfig: undefined,
    });

    assert.equal(seenPrompt, "hello");
  });

  it("includes canonical file paths in the Codex prompt for document-only turns", async () => {
    /** @type {string | null} */
    let seenPrompt = null;
    const harness = createCodexHarness({
      startRun: async (input) => {
        seenPrompt = input.prompt;
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
    });

    const mediaPath = `${"f".repeat(64)}.pdf`;
    const result = await harness.run({
      session: {
        chatId: "codex-chat-file-path",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-file-path",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: null,
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          listTools: () => [],
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{
        role: "user",
        content: [{
          type: "file",
          path: mediaPath,
          mime_type: "application/pdf",
          file_name: "report.pdf",
        }],
      }],
      hooks: {},
      runConfig: undefined,
    });

    assert.equal(seenPrompt, `Media file available in this request:\n- ${mediaPath}`);
    assert.deepEqual(result.response, [{ type: "text", text: "ok" }]);
  });

  it("executes queued action requests after the Codex run", async () => {
    /** @type {Array<{ name: string, params: Record<string, unknown> }>} */
    const executed = [];
    /** @type {ToolContentBlock[][]} */
    const emittedResults = [];
    /** @type {LlmChatResponse["toolCalls"][0][]} */
    const emittedCalls = [];
    /** @type {Message[]} */
    const storedMessages = [];
    const returnedBlocks = /** @type {ToolContentBlock[]} */ ([
      { type: "image", path: "chart.png", mime_type: "image/png" },
    ]);

    const harness = createCodexHarness({
      startRun: async (input) => {
        const requestsDir = input.env?.[ACTION_REQUESTS_ENV_VAR];
        assert.equal(typeof requestsDir, "string");
        await writeQueuedActionRequest(requestsDir, {
          kind: "whatsapp-action-request",
          action: "send_path",
          arguments: { path: "./chart.png" },
          cwd: "/repo",
        });
        return {
        abortController: new AbortController(),
        done: Promise.resolve({
          sessionId: null,
          result: {
            response: [{ type: "text", text: "queued request" }],
            messages: [],
            usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
          },
        }),
      };
      },
    });

    const result = await harness.run({
      session: {
        chatId: "codex-chat-queued-action",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-queued-action",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async (_chatId, message) => {
          storedMessages.push(message);
          return undefined;
        },
        updateToolMessage: async () => undefined,
        harnessSession: null,
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          listTools: () => [{
            name: "send_path",
            description: "Send a path back to chat.",
            parameters: { type: "object", properties: {} },
            permissions: {},
          }],
          getTool: async () => ({
            name: "send_path",
            description: "Send a path back to chat.",
            parameters: { type: "object", properties: {} },
            permissions: {},
          }),
          executeTool: async (toolName, _context, params, options) => {
            executed.push({ name: toolName, params });
            assert.equal(options.workdir, "/repo");
            return { result: returnedBlocks, permissions: {} };
          },
        }),
      },
      messages: [{ role: "user", content: [{ type: "text", text: "send the chart" }] }],
      hooks: {
        onToolCall: async (toolCall) => {
          emittedCalls.push(toolCall);
          return undefined;
        },
        onToolResult: async (blocks) => {
          emittedResults.push(blocks);
        },
      },
      runConfig: undefined,
    });

    assert.deepEqual(executed, [{
      name: "send_path",
      params: { path: "./chart.png" },
    }]);
    assert.equal(emittedCalls[0]?.name, "send_path");
    assert.deepEqual(emittedResults, [returnedBlocks]);
    assert.deepEqual(result.response, returnedBlocks);
    assert.equal(storedMessages[0]?.role, "tool");
  });

  it("renders canonical images as markdown with generated alt while keeping the media path", async () => {
    const mockServer = await createMockLlmServer();
    try {
      const llmClient = createLlmClient({
        apiKey: "test-key",
        baseURL: mockServer.url,
      });
      mockServer.addResponses("Two green iguanas standing upright and leaning against each other.");

      const mediaPath = await writeMedia(Buffer.from("iguanas"), "image/jpeg", "image");
      createdMediaPaths.add(mediaPath);
      const mediaFilePath = resolveMediaPath(mediaPath);

      /** @type {string | null} */
      let seenPrompt = null;
      const harness = createCodexHarness({
        startRun: async (input) => {
          seenPrompt = input.prompt;
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
      });

      await withModelsCache([
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        await harness.run({
          session: {
            chatId: "codex-chat-markdown-media",
            senderIds: [],
            context: /** @type {ExecuteActionContext} */ ({
              chatId: "codex-chat-markdown-media",
              senderIds: [],
              content: [],
              getIsAdmin: async () => true,
              send: async () => undefined,
              reply: async () => undefined,
              reactToMessage: async () => {},
              select: async () => "",
              confirm: async () => true,
            }),
            addMessage: async () => undefined,
            updateToolMessage: async () => undefined,
            harnessSession: null,
            saveHarnessSession: async () => undefined,
          },
          llmConfig: {
            llmClient,
            chatModel: "gpt-4.1",
            externalInstructions: "",
            mediaToTextModels: { image: "openai/gpt-4o" },
            toolRuntime: /** @type {ToolRuntime} */ ({
              listTools: () => [],
              getTool: async () => null,
              executeTool: async () => {
                throw new Error("executeTool should not be called");
              },
            }),
          },
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                path: mediaPath,
                mime_type: "image/jpeg",
              },
              { type: "text", text: "explain" },
            ],
          }],
          hooks: {},
          runConfig: { model: "gpt-5.4" },
        });
      });

      assert.equal(
        seenPrompt,
        `![Two green iguanas standing upright and leaning against each other.](${mediaFilePath})\nexplain`,
      );
    } finally {
      await mockServer.close();
    }
  });

  it("interrupts an active Codex run before falling back to abort", async () => {
    /** @type {string[]} */
    const calls = [];
    /** @type {(value: { sessionId: string | null, result: AgentResult }) => void} */
    let resolveDone = () => {};
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      calls.push("abort");
    });

    const harness = createCodexHarness({
      startRun: async () => ({
        abortController,
        steer: async () => true,
        interrupt: async () => {
          calls.push("interrupt");
          return true;
        },
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      }),
    });

    const runPromise = harness.run({
      session: {
        chatId: "codex-chat-interrupt",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "codex-chat-interrupt",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: { id: "sess-interrupt", kind: "codex" },
        saveHarnessSession: async () => undefined,
      },
      llmConfig: {
        llmClient: /** @type {LlmClient} */ ({}),
        chatModel: null,
        externalInstructions: "",
        toolRuntime: /** @type {ToolRuntime} */ ({
          getTool: async () => null,
          executeTool: async () => {
            throw new Error("executeTool should not be called");
          },
        }),
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {},
      runConfig: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelled = await harness.cancel?.("codex-chat-interrupt");
    assert.equal(cancelled, true);
    assert.deepEqual(calls, ["interrupt"]);

    resolveDone({
      sessionId: "sess-interrupt",
      result: {
        response: [],
        messages: [],
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      },
    });
    await runPromise;
  });
});

describe("buildCodexThreadOptions", () => {
  it("builds SDK thread options from run config", () => {
    const options = buildCodexThreadOptions({
      workdir: "/repo",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

    assert.deepEqual(options, {
      workingDirectory: "/repo",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
  });
});
