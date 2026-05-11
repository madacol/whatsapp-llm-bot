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
      onToolComplete: async () => {},
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

  it("emits Codex collab sub-agent responses as sub-agent output", async () => {
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
      },
      subagentResponses: [{
        threadId: "thread-child",
        text: "SUBAGENT_EVENT_TEST: quick sub-agent response",
      }],
    });

    assert.deepEqual(llmResponses, [{
      text: "SUBAGENT_EVENT_TEST: quick sub-agent response",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
      },
    }]);
  });

  it("emits standard spawn_agent/wait_agent completed statuses as sub-agent output", async () => {
    const { dispatcher, llmResponses } = createSubject();

    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-spawn",
        name: "spawn_agent",
        arguments: {},
        status: "completed",
        output: JSON.stringify({
          agent_id: "thread-child",
          nickname: "Kierkegaard",
        }),
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-wait",
        name: "wait_agent",
        arguments: {},
        status: "completed",
        output: JSON.stringify({
          status: {
            "thread-child": {
              completed: "SUBAGENT_VISUAL_TEST: hello from a spawned sub-agent.",
            },
          },
          timed_out: false,
        }),
      },
    });

    assert.deepEqual(llmResponses, [{
      text: "SUBAGENT_VISUAL_TEST: hello from a spawned sub-agent.",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
        agentNickname: "Kierkegaard",
      },
    }]);
  });

  it("correlates completed tool events with started tools when ids change", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {LlmChatResponse["toolCalls"]} */
    const completedToolCalls = [];
    /** @type {MessageInspectState[]} */
    const inspects = [];
    const dispatcher = createCodexEventDispatcher({
      messages: [],
      hooks: {
        onComposing: async () => {},
        onPaused: async () => {},
        onReasoning: async () => {},
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          return {
            keyId: "tool-message",
            isImage: false,
            update: async () => {},
            setInspect: (inspect) => {
              if (inspect) {
                inspects.push(structuredClone(inspect));
              }
            },
          };
        },
        onToolComplete: async (toolCall) => {
          completedToolCalls.push(toolCall);
        },
        onCommand: async () => {},
        onFileRead: async () => {},
        onPlan: async () => {},
        onFileChange: async () => {},
        onToolError: async () => {},
        onUsage: async () => {},
        onLlmResponse: async () => {},
      },
    });

    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-start",
        name: "spawn_agent",
        arguments: { message: "hello" },
        status: "started",
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-complete",
        name: "spawn_agent",
        arguments: { message: "hello" },
        status: "completed",
        output: JSON.stringify({
          agent_id: "thread-child",
          nickname: "Raman",
        }),
      },
    });

    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.id, "tool-start");
    assert.equal(completedToolCalls.length, 1);
    assert.equal(completedToolCalls[0]?.id, "tool-start");
    assert.equal(inspects.at(-1)?.kind, "tool");
    assert.equal(inspects.at(-1)?.output, JSON.stringify({
      agent_id: "thread-child",
      nickname: "Raman",
    }));
  });

  it("does not redisplay a completed tool when the started tool has no handle", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {LlmChatResponse["toolCalls"]} */
    const completedToolCalls = [];
    const dispatcher = createCodexEventDispatcher({
      messages: [],
      hooks: {
        onComposing: async () => {},
        onPaused: async () => {},
        onReasoning: async () => {},
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          return undefined;
        },
        onToolComplete: async (toolCall) => {
          completedToolCalls.push(toolCall);
        },
        onCommand: async () => {},
        onFileRead: async () => {},
        onPlan: async () => {},
        onFileChange: async () => {},
        onToolError: async () => {},
        onUsage: async () => {},
        onLlmResponse: async () => {},
      },
    });

    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-start",
        name: "spawn_agent",
        arguments: { message: "hello" },
        status: "started",
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-complete",
        name: "spawn_agent",
        arguments: { message: "hello" },
        status: "completed",
        output: JSON.stringify({
          agent_id: "thread-child",
          nickname: "Kuhn",
        }),
      },
    });

    assert.deepEqual(toolCalls, [{
      id: "tool-start",
      name: "spawn_agent",
      arguments: JSON.stringify({ message: "hello" }),
    }]);
    assert.deepEqual(completedToolCalls, [{
      id: "tool-start",
      name: "spawn_agent",
      arguments: JSON.stringify({ message: "hello" }),
    }]);
  });

  it("enriches an already-known sub-agent thread with standard spawn_agent nickname output", async () => {
    const { dispatcher, llmResponses } = createSubject();

    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-spawn-collab",
        name: "spawn_agent",
        arguments: { receiver_thread_ids: ["thread-child"] },
        status: "completed",
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      toolEvent: {
        id: "tool-spawn-standard",
        name: "spawn_agent",
        arguments: {},
        status: "completed",
        output: JSON.stringify({
          agent_id: "thread-child",
          nickname: "Planck",
        }),
      },
    });
    await dispatcher.handleNormalized({
      sessionId: "thread-parent",
      subagentResponses: [{
        threadId: "thread-child",
        text: "SUBAGENT_HEADER_LIVE_PROOF: hello from sub-agent.",
      }],
    });

    assert.deepEqual(llmResponses, [{
      text: "SUBAGENT_HEADER_LIVE_PROOF: hello from sub-agent.",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
        agentNickname: "Planck",
      },
    }]);
  });
});
