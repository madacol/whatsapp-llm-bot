import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentRunActivityReconciliation } from "../harnesses/agent-run-activity-reconciliation.js";

describe("Agent Run Activity reconciliation", () => {
  it("owns reasoning delta completion before downstream presentation", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    const activity = createAgentRunActivityReconciliation({
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
        onLlmResponse: async () => {},
      },
    });

    await activity.emitReasoning({
      type: "reasoning.updated",
      provider: "acp",
      status: "updated",
      text: "Inspect",
      contentParts: ["Inspect"],
      summaryParts: [],
      appendMode: "delta",
    });
    await activity.emitReasoning({
      type: "reasoning.updated",
      provider: "acp",
      status: "updated",
      text: "ing the request.",
      contentParts: ["ing the request."],
      summaryParts: [],
      appendMode: "delta",
    });
    await activity.completeOpenReasoning();

    assert.deepEqual(reasoningEvents.at(-1), {
      status: "completed",
      summaryParts: [],
      contentParts: ["Inspecting the request."],
      text: "Inspecting the request.",
    });
  });

  it("owns subagent thread naming and wait-agent response dedupe", async () => {
    /** @type {Array<{ text: string, metadata?: LlmResponseMetadata }>} */
    const responses = [];
    const activity = createAgentRunActivityReconciliation({
      hooks: {
        onReasoning: async () => {},
        onLlmResponse: async (text, metadata) => {
          responses.push({ text, metadata });
        },
      },
    });

    activity.rememberSpawnedSubagent({
      id: "spawn-1",
      name: "spawn_agent",
      arguments: {
        receiverThreadIds: ["thread-1"],
        prompt: "Review the patch. Return only findings.",
      },
    });
    const childToolEvent = activity.enrichSubagentToolEvent({
      type: "tool.started",
      provider: "acp",
      tool: {
        id: "child-1",
        name: "Read",
        arguments: {},
        subagent: { source: "subagent", threadId: "thread-1" },
      },
    });

    if (childToolEvent.type !== "tool.started") {
      assert.fail(`expected tool.started event, got ${childToolEvent.type}`);
    }
    assert.deepEqual(childToolEvent.tool.subagent, {
      source: "subagent",
      threadId: "thread-1",
      agentNickname: "Review the patch",
    });

    const waitTool = {
      id: "wait-1",
      name: "wait_agent",
      arguments: {},
      output: JSON.stringify({
        status: {
          "thread-1": { completed: "Looks good." },
        },
      }),
    };
    await activity.emitWaitAgentResponses(waitTool);
    await activity.emitWaitAgentResponses(waitTool);

    assert.deepEqual(responses, [{
      text: "Looks good.",
      metadata: {
        source: "subagent",
        threadId: "thread-1",
        agentNickname: "Review the patch",
      },
    }]);
  });
});
