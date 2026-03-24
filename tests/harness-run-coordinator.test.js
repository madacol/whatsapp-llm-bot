import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessRunCoordinator } from "../harnesses/run-coordinator.js";

/**
 * @param {string} chatId
 * @param {string} text
 * @returns {ChatTurn}
 */
function createTurn(chatId, text) {
  return {
    chatId,
    senderIds: ["user-1"],
    senderName: "User",
    content: [{ type: "text", text }],
    timestamp: new Date("2026-03-23T20:00:00.000Z"),
    facts: {
      isGroup: false,
      addressedToBot: false,
      repliedToBot: false,
    },
    io: {
      send: async () => undefined,
      reply: async () => undefined,
      select: async () => "",
      confirm: async () => true,
      react: async () => {},
      startPresence: async () => {},
      keepPresenceAlive: async () => {},
      endPresence: async () => {},
      getIsAdmin: async () => true,
    },
  };
}

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
    const started = coordinator.beginRun({ turn: createTurn("chat-1", "first"), userText: "first", harness });
    const buffered = coordinator.beginRun({ turn: createTurn("chat-1", "second"), userText: "second", harness });

    assert.equal(started.status, "started");
    assert.equal(buffered.status, "buffered");
    assert.deepEqual(coordinator.consumeBufferedTexts("chat-1"), ["second"]);
    assert.equal(coordinator.finishRun("chat-1"), null);
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
    const started = coordinator.beginRun({ turn: createTurn("chat-2", "first"), userText: "first", harness });
    coordinator.markRunActive("chat-2");
    const injectedResult = coordinator.beginRun({ turn: createTurn("chat-2", "follow-up"), userText: "follow-up", harness });

    assert.equal(started.status, "started");
    assert.equal(injectedResult.status, "injected");
    assert.deepEqual(injected, ["chat-2:follow-up"]);
    assert.equal(coordinator.finishRun("chat-2"), null);
  });

  it("returns the latest buffered turn after a non-live run finishes", () => {
    /** @type {AgentHarness} */
    const harness = {
      getName: () => "codex",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: true,
        supportsLiveInput: false,
        supportsApprovals: true,
        supportsWorkdir: true,
        supportsSandboxConfig: true,
        supportsModelSelection: true,
        supportsReasoningEffort: false,
        supportsSessionFork: false,
      }),
      run: async () => ({ response: [], messages: [], usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 } }),
      handleCommand: async () => false,
    };

    const coordinator = createHarnessRunCoordinator();
    coordinator.beginRun({ turn: createTurn("chat-3", "first"), userText: "first", harness });
    coordinator.markRunActive("chat-3");
    const buffered = coordinator.beginRun({ turn: createTurn("chat-3", "second"), userText: "second", harness });

    assert.equal(buffered.status, "buffered");
    assert.equal(coordinator.consumeBufferedTexts("chat-3").length, 0);
    assert.equal(coordinator.finishRun("chat-3")?.content[0]?.type, "text");
    if (coordinator.finishRun("chat-3") !== null) {
      assert.fail("Expected buffered turn queue to be drained after finishRun");
    }
  });
});
