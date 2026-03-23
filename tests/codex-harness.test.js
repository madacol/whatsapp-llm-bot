import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { setDb } from "../db.js";
import { createTestDb, seedChat } from "./helpers.js";
import {
  buildCodexThreadOptions,
  createCodexHarness,
} from "../harnesses/codex.js";

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

describe("createCodexHarness", () => {
  it("exposes the unified harness contract", () => {
    const harness = createCodexHarness();

    assert.equal(harness.getName(), "codex");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.deepEqual(harness.getCapabilities(), {
      supportsResume: true,
      supportsCancel: true,
      supportsLiveInput: false,
      supportsApprovals: true,
      supportsWorkdir: true,
      supportsSandboxConfig: true,
      supportsModelSelection: true,
      supportsReasoningEffort: false,
      supportsSessionFork: false,
    });
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
