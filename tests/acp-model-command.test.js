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
 * @param {(sessionId: string | null, commandSpec: { command: string, args: string[] }) => Promise<{ configOptions: Record<string, unknown>[], modelState: { currentModelId?: string, availableModels: Array<{ modelId: string, name: string, description?: string }> } | null }>} loadControlState
 * @param {(() => Promise<string>) | undefined} [readCodexStatus]
 * @returns {(input: HarnessCommandContext) => Promise<boolean>}
 */
function createModelCommandHandler(loadControlState, readCodexStatus = undefined) {
  return __testAcpModelCommand.createGenericAcpCommandHandler({
    harnessName: "codex",
    label: "Codex",
    sessionKind: "codex",
    commandSpec: { command: "mock-acp", args: [] },
    cancelActiveQuery: () => false,
    loadControlState,
    readCodexStatus,
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
