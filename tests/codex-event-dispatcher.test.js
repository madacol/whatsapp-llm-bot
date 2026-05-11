import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCodexEventDispatcher } from "../harnesses/codex-event-dispatcher.js";

/**
 * @returns {{
 *   dispatcher: ReturnType<typeof createCodexEventDispatcher>,
 *   llmResponses: Array<{ text: string, metadata?: LlmResponseMetadata }>,
 * }}
 */
function createSubject() {
  /** @type {Array<{ text: string, metadata?: LlmResponseMetadata }>} */
  const llmResponses = [];
  const dispatcher = createCodexEventDispatcher({
    messages: [],
    hooks: {
      onComposing: async () => {},
      onPaused: async () => {},
      onReasoning: async () => {},
      onToolCall: async () => {},
      onCommand: async () => {},
      onFileRead: async () => {},
      onPlan: async () => {},
      onFileChange: async () => {},
      onToolError: async () => {},
      onUsage: async () => {},
      onLlmResponse: async (text, metadata) => {
        llmResponses.push({ text, ...(metadata ? { metadata } : {}) });
      },
    },
  });
  return { dispatcher, llmResponses };
}

describe("createCodexEventDispatcher", () => {
  it("tags assistant text from known sub-agent threads", async () => {
    const { dispatcher, llmResponses } = createSubject();

    await dispatcher.handleNormalized({
      sessionId: "thread-child",
      threadEvent: {
        id: "thread-child",
        kind: "subagent",
        parentThreadId: "thread-parent",
        agentNickname: "Mill",
        agentRole: "worker",
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-child",
      assistantText: "SUBAGENT_VISIBLE_TEST: hello from the spawned sub-agent.",
    });

    assert.deepEqual(llmResponses, [{
      text: "SUBAGENT_VISIBLE_TEST: hello from the spawned sub-agent.",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
        parentThreadId: "thread-parent",
        agentNickname: "Mill",
        agentRole: "worker",
      },
    }]);
  });

  it("tags assistant text as sub-agent output after spawn_agent reports receiver threads", async () => {
    const { dispatcher, llmResponses } = createSubject();

    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-1",
        name: "spawn_agent",
        arguments: { receiver_thread_ids: ["thread-child"] },
        status: "completed",
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-child",
      assistantText: "sub-agent response",
    });

    assert.equal(llmResponses[0]?.metadata?.source, "subagent");
  });

  it("emits completed wait_agent output as sub-agent output", async () => {
    const { dispatcher, llmResponses } = createSubject();

    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-1",
        name: "spawn_agent",
        arguments: { receiver_thread_ids: ["thread-child"] },
        status: "completed",
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-2",
        name: "wait_agent",
        arguments: { receiver_thread_ids: ["thread-child"] },
        status: "completed",
        output: "SUBAGENT_EVENT_TEST: quick sub-agent response",
      },
    });

    assert.deepEqual(llmResponses, [{
      text: "SUBAGENT_EVENT_TEST: quick sub-agent response",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
      },
    }]);
  });
});
