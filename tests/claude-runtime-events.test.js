import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClaudeAssistantEvent,
  normalizeClaudeResultEvent,
} from "../harnesses/claude-runtime-events.js";

describe("Claude runtime event normalization", () => {
  it("normalizes assistant text, tool blocks, and additive usage", () => {
    const normalized = normalizeClaudeAssistantEvent({
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "sess-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Working." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
        },
      },
    });

    assert.deepEqual(normalized.runtimeEvents, [{
      type: "assistant.completed",
      provider: "claude-agent-sdk",
      text: "Working.",
      contentType: "text",
      responseMode: "append",
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        cachedTokens: 2,
        cost: 0,
      },
      usageMode: "add",
      raw: {
        type: "assistant",
        parent_tool_use_id: null,
        session_id: "sess-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Working." },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 2,
          },
        },
      },
    }]);
    assert.deepEqual(normalized.storedBlocks, [
      { type: "text", text: "Working." },
      {
        type: "tool",
        tool_id: "tool-1",
        name: "Read",
        arguments: JSON.stringify({ file_path: "README.md" }),
      },
    ]);
    assert.equal(normalized.shouldPersist, true);
  });

  it("normalizes sub-agent assistant text as display-only", () => {
    const normalized = normalizeClaudeAssistantEvent({
      type: "assistant",
      parent_tool_use_id: "agent-tool-1",
      session_id: "sess-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub result." }],
      },
    });

    assert.deepEqual(normalized.runtimeEvents, [{
      type: "assistant.completed",
      provider: "claude-agent-sdk",
      text: "Sub result.",
      displayText: "*Agent:* Sub result.",
      contentType: "text",
      responseMode: "none",
      raw: {
        type: "assistant",
        parent_tool_use_id: "agent-tool-1",
        session_id: "sess-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Sub result." }],
        },
      },
    }]);
    assert.deepEqual(normalized.storedBlocks, [{ type: "text", text: "Sub result." }]);
    assert.equal(normalized.shouldPersist, false);
  });

  it("normalizes result usage and cost as replacement state", () => {
    const normalized = normalizeClaudeResultEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Final.",
      usage: {
        input_tokens: 25,
        output_tokens: 8,
        cache_read_input_tokens: 3,
      },
      total_cost_usd: 0.42,
    });

    assert.deepEqual(normalized.runtimeEvent, {
      type: "assistant.completed",
      provider: "claude-agent-sdk",
      text: "Final.",
      contentType: "text",
      responseMode: "replace",
      usage: {
        promptTokens: 25,
        completionTokens: 8,
        cachedTokens: 3,
        cost: 0.42,
      },
      usageMode: "replace",
      raw: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Final.",
        usage: {
          input_tokens: 25,
          output_tokens: 8,
          cache_read_input_tokens: 3,
        },
        total_cost_usd: 0.42,
      },
    });
    assert.deepEqual(normalized.errorMessages, []);
  });
});
