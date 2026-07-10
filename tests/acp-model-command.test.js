import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __testAcpModelCommand } from "../harnesses/acp.js";

/**
 * @returns {MessageHandle}
 */
function createNoopMessageHandle() {
  return {
    update: async () => {},
    setInspect: () => {},
  };
}

/**
 * @returns {ExecuteActionContext}
 */
function createContext() {
  return /** @type {ExecuteActionContext} */ ({
    chatId: "acp-model-command-test",
    senderIds: [],
    content: [],
    getIsAdmin: async () => true,
    send: async () => createNoopMessageHandle(),
    reply: async () => createNoopMessageHandle(),
    reactToMessage: async () => {},
    select: async () => "",
    confirm: async () => true,
  });
}

/**
 * @param {string[]} replies
 * @returns {ExecuteActionContext}
 */
function createRecordingContext(replies) {
  const context = createContext();
  context.reply = async (event) => {
    replies.push(event.kind === "app_message" && typeof event.content === "string" ? event.content : JSON.stringify(event));
    return createNoopMessageHandle();
  };
  return context;
}

/**
 * @param {string | null} sessionId
 * @param {HarnessSessionRef["kind"]} [kind]
 * @returns {import("../store.js").ChatRow}
 */
function createChatInfo(sessionId, kind = "codex") {
  return /** @type {import("../store.js").ChatRow} */ ({
    chat_id: "acp-model-command-test",
    is_enabled: true,
    system_prompt: null,
    model: null,
    respond_on_any: false,
    respond_on_mention: true,
    respond_on_reply: true,
    respond_on: "mention",
    debug: false,
    media_to_text_models: {},
    model_roles: {},
    memory: false,
    memory_threshold: null,
    active_persona: null,
    harness: null,
    harness_cwd: null,
    output_visibility: {},
    harness_config: {},
    harness_session_kind: kind,
    harness_session_id: sessionId,
    harness_session_history: [],
    harness_fork_stack: [],
    timestamp: "2026-03-23T20:00:00.000Z",
  });
}

/**
 * @param {(sessionId: string | null, commandSpec: { command: string, args: string[] }) => Promise<{ configOptions: Record<string, unknown>[], modelState: { currentModelId?: string, availableModels: Array<{ modelId: string, name: string, description?: string }> } | null }>} loadControlState
 * @param {(() => Promise<string>) | undefined} [readCodexStatus]
 * @param {((input: { command: string, args?: string[], sessionId: string }) => Promise<unknown>) | undefined} [compactSession]
 * @returns {(input: HarnessCommandContext) => Promise<boolean>}
 */
function createModelCommandHandler(loadControlState, readCodexStatus = undefined, compactSession = undefined) {
  return __testAcpModelCommand.createGenericAcpCommandHandler({
    harnessName: "codex",
    label: "Codex",
    sessionKind: "codex",
    commandSpec: { command: "mock-acp", args: [] },
    cancelActiveQuery: () => false,
    loadControlState,
    readCodexStatus,
    compactSession,
  });
}

describe("ACP /model command option derivation", () => {
  it("derives model and effort choices from ACP session model state", () => {
    const modelState = {
      currentModelId: "gpt-5.5[medium]",
      availableModels: [
        { modelId: "gpt-5.5[low]", name: "GPT-5.5 (low)", description: "Lower latency" },
        { modelId: "gpt-5.5[medium]", name: "GPT-5.5 (medium)", description: "Balanced" },
        { modelId: "gpt-5.5[high]", name: "GPT-5.5 (high)", description: "Deeper reasoning" },
        { modelId: "gpt-5.4[medium]", name: "GPT-5.4 (medium)", description: "Previous model" },
      ],
    };

    assert.deepEqual(__testAcpModelCommand.modelStateModelOptions(modelState), [
      { id: "gpt-5.5", label: "GPT-5.5", description: "Lower latency" },
      { id: "gpt-5.4", label: "GPT-5.4", description: "Previous model" },
    ]);
    assert.deepEqual(__testAcpModelCommand.modelStateEffortOptions(modelState, "gpt-5.5"), [
      { id: "low", label: "low", description: "Lower latency" },
      { id: "medium", label: "medium", description: "Balanced" },
      { id: "high", label: "high", description: "Deeper reasoning" },
    ]);
  });

  it("detects fast mode only when the provider exposes a matching config option", () => {
    assert.equal(__testAcpModelCommand.findFastModeConfigOption([]), null);

    const optionByCategory = {
      type: "boolean",
      id: "speed",
      name: "Speed",
      category: "fast_mode",
    };
    const optionByName = {
      type: "boolean",
      id: "quick-toggle",
      name: "Fast Mode",
    };
    const codexModelConfigOption = {
      type: "boolean",
      id: "fast_mode",
      name: "Fast mode",
      category: "model_config",
    };

    assert.equal(__testAcpModelCommand.findFastModeConfigOption([optionByCategory]), optionByCategory);
    assert.equal(__testAcpModelCommand.findFastModeConfigOption([optionByName]), optionByName);
    assert.equal(__testAcpModelCommand.findFastModeConfigOption([codexModelConfigOption]), codexModelConfigOption);
  });

  it("parses ACP model ids with optional effort suffixes", () => {
    assert.deepEqual(__testAcpModelCommand.parseAcpModelId("gpt-5.5[high]"), {
      model: "gpt-5.5",
      effort: "high",
    });
    assert.deepEqual(__testAcpModelCommand.parseAcpModelId("gpt-5.5"), {
      model: "gpt-5.5",
      effort: null,
    });
  });

  it("propagates ACP control-state loader failures instead of falling back to defaults", async () => {
    const handler = createModelCommandHandler(async () => {
      throw new Error("provider control state failed");
    });

    await assert.rejects(
      handler({
        chatId: "acp-model-loader-failure",
        command: "model",
        context: createContext(),
      }),
      /provider control state failed/,
    );
  });

  it("handles Codex /status by reading a fresh Codex CLI status panel", async () => {
    /** @type {string[]} */
    const replies = [];
    const handler = createModelCommandHandler(async () => ({
      configOptions: [],
      modelState: null,
    }), async () => [
      ">_ OpenAI Codex (v0.139.0)",
      "Model: gpt-5.5 (reasoning high)",
      "Account: user@example.com (Pro)",
      "Weekly limit: [██░░] 15% left",
    ].join("\n"));

    const context = createContext();
    context.reply = async (event) => {
      replies.push(event.kind === "app_message" && typeof event.content === "string" ? event.content : JSON.stringify(event));
      return createNoopMessageHandle();
    };

    assert.equal(await handler({
      chatId: "acp-status-command",
      command: "status",
      context,
    }), true);
    assert.equal(replies.length, 1);
    assert.match(replies[0] ?? "", /Codex status:/);
    assert.match(replies[0] ?? "", /Weekly limit: \[██░░\] 15% left/);
  });

  it("handles /compact by compacting the active ACP session", async () => {
    /** @type {Array<{ command: string, args?: string[], sessionId: string }>} */
    const compactCalls = [];
    /** @type {string[]} */
    const replies = [];
    const handler = createModelCommandHandler(async () => ({
      configOptions: [],
      modelState: null,
    }), undefined, async (input) => {
      compactCalls.push(input);
      return { ok: true };
    });

    assert.equal(await handler({
      chatId: "codex-compact-command",
      chatInfo: createChatInfo("codex-session-1"),
      command: "compact",
      context: createRecordingContext(replies),
    }), true);

    assert.deepEqual(compactCalls, [{ command: "mock-acp", args: [], sessionId: "codex-session-1" }]);
    assert.deepEqual(replies, ["Codex ACP context compaction requested."]);
  });

  it("reports /compact when no Codex session exists", async () => {
    /** @type {string[]} */
    const replies = [];
    const handler = createModelCommandHandler(async () => ({
      configOptions: [],
      modelState: null,
    }), undefined, async () => {
      throw new Error("compact should not run without a session");
    });

    assert.equal(await handler({
      chatId: "codex-compact-missing-session",
      chatInfo: createChatInfo(null),
      command: "compact",
      context: createRecordingContext(replies),
    }), true);

    assert.match(replies[0] ?? "", /Start a Codex ACP session first/);
  });

  it("reports /compact provider failures", async () => {
    /** @type {string[]} */
    const replies = [];
    const handler = createModelCommandHandler(async () => ({
      configOptions: [],
      modelState: null,
    }), undefined, async () => {
      throw new Error("thread/compact/start unavailable");
    });

    assert.equal(await handler({
      chatId: "codex-compact-failure",
      chatInfo: createChatInfo("codex-session-1"),
      command: "compact",
      context: createRecordingContext(replies),
    }), true);

    assert.match(replies[0] ?? "", /Codex ACP compact failed: thread\/compact\/start unavailable/);
  });

  it("does not claim /status for non-Codex ACP harnesses", async () => {
    const handler = __testAcpModelCommand.createGenericAcpCommandHandler({
      harnessName: "claude",
      label: "Claude",
      sessionKind: "claude",
      commandSpec: { command: "mock-acp", args: [] },
      cancelActiveQuery: () => false,
      loadControlState: async () => ({ configOptions: [], modelState: null }),
      readCodexStatus: async () => {
        throw new Error("non-Codex status should not read Codex CLI");
      },
    });

    assert.equal(await handler({
      chatId: "claude-status-command",
      command: "status",
      context: createContext(),
    }), false);
  });

  it("passes /compact to non-Codex ACP providers that implement compaction", async () => {
    /** @type {Array<{ command: string, args?: string[], sessionId: string }>} */
    const compactCalls = [];
    /** @type {string[]} */
    const replies = [];
    const handler = __testAcpModelCommand.createGenericAcpCommandHandler({
      harnessName: "claude",
      label: "Claude",
      sessionKind: "claude",
      commandSpec: { command: "mock-acp", args: [] },
      cancelActiveQuery: () => false,
      loadControlState: async () => ({ configOptions: [], modelState: null }),
      compactSession: async (input) => {
        compactCalls.push(input);
        return { compactRequested: true };
      },
    });

    assert.equal(await handler({
      chatId: "claude-compact-command",
      chatInfo: createChatInfo("claude-session-1", "claude"),
      command: "compact",
      context: createRecordingContext(replies),
    }), true);
    assert.deepEqual(compactCalls, [{ command: "mock-acp", args: [], sessionId: "claude-session-1" }]);
    assert.deepEqual(replies, ["Claude ACP context compaction requested."]);
  });

  it("reports unsupported /compact for ACP providers without the compact extension", async () => {
    /** @type {string[]} */
    const replies = [];
    const handler = __testAcpModelCommand.createGenericAcpCommandHandler({
      harnessName: "pi",
      label: "Pi",
      sessionKind: "pi",
      commandSpec: { command: "mock-acp", args: [] },
      cancelActiveQuery: () => false,
      loadControlState: async () => ({ configOptions: [], modelState: null }),
      compactSession: async () => {
        throw new Error("ACP agent did not acknowledge session/compact.");
      },
    });

    assert.equal(await handler({
      chatId: "pi-compact-command",
      chatInfo: createChatInfo("pi-session-1", "pi"),
      command: "compact",
      context: createRecordingContext(replies),
    }), true);
    assert.deepEqual(replies, ["Pi ACP does not support `/compact`."]);
  });

  it("throws when fast mode is requested but the ACP agent did not expose it", async () => {
    const handler = createModelCommandHandler(async () => ({
      configOptions: [],
      modelState: null,
    }));

    await assert.rejects(
      handler({
        chatId: "acp-model-fast-unsupported",
        command: "model fast on",
        context: createContext(),
      }),
      /fast mode is not exposed/,
    );
  });
});
