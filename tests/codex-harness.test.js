import { afterEach, describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { setDb } from "../db.js";
import { createMockLlmServer, createTestDb, seedChat, withModelsCache } from "./helpers.js";
import {
  buildCodexThreadOptions,
  createCodexHarness,
} from "../harnesses/codex.js";
import { createLlmClient } from "../llm.js";
import { resolveMediaPath, writeMedia } from "../media-store.js";

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
      supportsSessionFork: false,
    });
    assert.deepEqual(harness.listSlashCommands(), [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
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
        `![Two green iguanas standing upright and leaning against each other.](${mediaPath})\nexplain`,
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
