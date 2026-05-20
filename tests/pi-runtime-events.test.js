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

  it("normalizes Pi RPC lowercase built-in tools and file changes", () => {
    assert.deepEqual(normalizePiRuntimeEvents({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md", offset: 1, limit: 20 },
    }), [{
      type: "tool.started",
      provider: "pi",
      tool: {
        id: "read-1",
        name: "Read",
        arguments: { path: "README.md", offset: 1, limit: 20, file_path: "README.md" },
      },
      raw: {
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "README.md", offset: 1, limit: 20 },
      },
    }]);

    assert.deepEqual(normalizePiRuntimeEvents({
      type: "tool_execution_end",
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "pwd" },
      result: { content: [{ type: "text", text: "/repo\n" }] },
      isError: false,
    }), [{
      type: "tool.completed",
      provider: "pi",
      tool: {
        id: "bash-1",
        name: "Bash",
        arguments: { command: "pwd" },
        output: "/repo",
      },
      raw: {
        type: "tool_execution_end",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "pwd" },
        result: { content: [{ type: "text", text: "/repo\n" }] },
        isError: false,
      },
    }]);

    assert.deepEqual(normalizePiRuntimeEvents({
      type: "tool_execution_end",
      toolCallId: "edit-1",
      toolName: "edit",
      args: {
        path: "src/app.js",
        edits: [{ oldText: "const value = 1;\n", newText: "const value = 2;\n" }],
      },
      result: {
        content: [{ type: "text", text: "Edited src/app.js" }],
        details: {
          diff: ["--- a/src/app.js", "+++ b/src/app.js", "@@ -1 +1 @@", "-const value = 1;", "+const value = 2;"].join("\n"),
        },
      },
      isError: false,
    }), [
      {
        type: "tool.completed",
        provider: "pi",
        tool: {
          id: "edit-1",
          name: "Edit",
          arguments: {
            path: "src/app.js",
            edits: [{ oldText: "const value = 1;\n", newText: "const value = 2;\n" }],
            file_path: "src/app.js",
            old_string: "const value = 1;\n",
            new_string: "const value = 2;\n",
          },
          output: "Edited src/app.js",
        },
        raw: {
          type: "tool_execution_end",
          toolCallId: "edit-1",
          toolName: "edit",
          args: {
            path: "src/app.js",
            edits: [{ oldText: "const value = 1;\n", newText: "const value = 2;\n" }],
          },
          result: {
            content: [{ type: "text", text: "Edited src/app.js" }],
            details: {
              diff: ["--- a/src/app.js", "+++ b/src/app.js", "@@ -1 +1 @@", "-const value = 1;", "+const value = 2;"].join("\n"),
            },
          },
          isError: false,
        },
      },
      {
        type: "file-change.completed",
        provider: "pi",
        change: {
          path: "src/app.js",
          summary: "src/app.js (update)",
          kind: "update",
          diff: ["--- a/src/app.js", "+++ b/src/app.js", "@@ -1 +1 @@", "-const value = 1;", "+const value = 2;"].join("\n"),
          oldText: "const value = 1;\n",
          newText: "const value = 2;\n",
        },
        raw: {
          type: "tool_execution_end",
          toolCallId: "edit-1",
          toolName: "edit",
          args: {
            path: "src/app.js",
            edits: [{ oldText: "const value = 1;\n", newText: "const value = 2;\n" }],
          },
          result: {
            content: [{ type: "text", text: "Edited src/app.js" }],
            details: {
              diff: ["--- a/src/app.js", "+++ b/src/app.js", "@@ -1 +1 @@", "-const value = 1;", "+const value = 2;"].join("\n"),
            },
          },
          isError: false,
        },
      },
    ]);
  });
});
