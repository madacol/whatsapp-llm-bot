import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePiRuntimeEvents } from "../harnesses/pi-runtime-events.js";

describe("normalizePiRuntimeEvents", () => {
  it("normalizes Pi reasoning, tool lifecycle, and final assistant events", () => {
    assert.deepEqual(normalizePiRuntimeEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta" },
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking state." }],
      },
    }), [{
      type: "reasoning.updated",
      provider: "pi",
      status: "updated",
      text: "Checking state.",
      raw: {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta" },
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Checking state." }],
        },
      },
    }]);

    assert.deepEqual(normalizePiRuntimeEvents({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "Read",
      args: { file_path: "README.md" },
    }), [{
      type: "tool.started",
      provider: "pi",
      tool: {
        id: "call-1",
        name: "Read",
        arguments: { file_path: "README.md" },
      },
      raw: {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "Read",
        args: { file_path: "README.md" },
      },
    }]);

    assert.deepEqual(normalizePiRuntimeEvents({
      type: "agent_end",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        usage: {
          input: 120,
          output: 34,
          cacheRead: 5,
          cost: { total: 0.123 },
        },
      }],
    }), [{
      type: "assistant.completed",
      provider: "pi",
      text: "Done.",
      contentType: "markdown",
      usage: {
        promptTokens: 120,
        completionTokens: 34,
        cachedTokens: 5,
        cost: 0.123,
      },
      raw: {
        type: "agent_end",
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          usage: {
            input: 120,
            output: 34,
            cacheRead: 5,
            cost: { total: 0.123 },
          },
        }],
      },
    }]);
  });
});
