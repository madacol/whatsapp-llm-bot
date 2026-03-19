import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessRunCoordinator } from "../harnesses/run-coordinator.js";

describe("createHarnessRunCoordinator", () => {
  it("buffers messages while a run is pending setup", () => {
    /** @type {AgentHarness} */
    const harness = {
      getName: () => "native",
      getCapabilities: () => ({
        supportsResume: false,
        supportsCancel: false,
        supportsLiveInput: false,
        supportsApprovals: false,
        supportsWorkdir: false,
        supportsSandboxConfig: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsSessionFork: false,
      }),
      run: async () => ({ response: [], messages: [], usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 } }),
      handleCommand: async () => false,
    };

    const coordinator = createHarnessRunCoordinator();
    const started = coordinator.beginRun({ chatId: "chat-1", userText: "first", harness });
    const buffered = coordinator.beginRun({ chatId: "chat-1", userText: "second", harness });

    assert.equal(started.status, "started");
    assert.equal(buffered.status, "buffered");
    assert.deepEqual(coordinator.consumeBufferedTexts("chat-1"), ["second"]);
    coordinator.finishRun("chat-1");
  });

  it("injects into an active harness query before starting a second run", () => {
    /** @type {string[]} */
    const injected = [];
    /** @type {AgentHarness} */
    const harness = {
      getName: () => "claude-agent-sdk",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: true,
        supportsLiveInput: true,
        supportsApprovals: true,
        supportsWorkdir: true,
        supportsSandboxConfig: false,
        supportsModelSelection: true,
        supportsReasoningEffort: true,
        supportsSessionFork: false,
      }),
      run: async () => ({ response: [], messages: [], usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 } }),
      handleCommand: async () => false,
      injectMessage: (chatId, text) => {
        injected.push(`${typeof chatId === "string" ? chatId : chatId.id}:${text}`);
        return true;
      },
    };

    const coordinator = createHarnessRunCoordinator();
    const started = coordinator.beginRun({ chatId: "chat-2", userText: "first", harness });
    coordinator.markRunActive("chat-2");
    const injectedResult = coordinator.beginRun({ chatId: "chat-2", userText: "follow-up", harness });

    assert.equal(started.status, "started");
    assert.equal(injectedResult.status, "injected");
    assert.deepEqual(injected, ["chat-2:follow-up"]);
    coordinator.finishRun("chat-2");
  });
});
