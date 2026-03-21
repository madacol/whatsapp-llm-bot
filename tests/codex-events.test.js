import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexSessionId,
  extractCodexText,
  normalizeCodexEvent,
} from "../harnesses/codex-events.js";

describe("codex events", () => {
  it("extracts session ids from thread and session fields", () => {
    assert.equal(extractCodexSessionId({ thread_id: "thread-1" }), "thread-1");
    assert.equal(extractCodexSessionId({ session_id: "session-1" }), "session-1");
    assert.equal(extractCodexSessionId({ item: { thread: { id: "thread-2" } } }), "thread-2");
  });

  it("extracts nested text from event payloads", () => {
    assert.equal(extractCodexText({ content: [{ text: "hello" }, { text: "world" }] }), "hello\nworld");
    assert.equal(extractCodexText({ steps: [{ text: "first" }, { text: "second" }] }), "first\nsecond");
  });

  it("normalizes command events", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "pnpm test",
        aggregated_output: "ok",
      },
    }), {
      sessionId: null,
      commandEvent: {
        command: "pnpm test",
        status: "completed",
        output: "ok",
      },
    });
  });

  it("normalizes mcp tool call events", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.started",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "functions",
        tool: "spawn_agent",
        arguments: { message: "hello" },
        status: "in_progress",
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "tool-1",
        name: "spawn_agent",
        arguments: { message: "hello" },
        status: "started",
      },
    });

    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        server: "functions",
        tool: "spawn_agent",
        arguments: { message: "hello" },
        result: {
          content: [{ type: "text", text: "agent-pass-2" }],
          structured_content: null,
        },
        status: "completed",
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "tool-1",
        name: "spawn_agent",
        arguments: { message: "hello" },
        status: "completed",
        output: "agent-pass-2",
      },
    });
  });

  it("extracts structured MCP tool results when no text block is present", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "tool-2",
        type: "mcp_tool_call",
        server: "functions",
        tool: "update_plan",
        arguments: {
          plan: [{ step: "Do work", status: "completed" }],
        },
        result: {
          content: [],
          structured_content: {
            output: "Plan updated",
          },
        },
        status: "completed",
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "tool-2",
        name: "update_plan",
        arguments: {
          plan: [{ step: "Do work", status: "completed" }],
        },
        status: "completed",
        output: "Plan updated",
      },
    });
  });

  it("extracts non-text MCP tool content blocks as JSON when needed", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "tool-3",
        type: "mcp_tool_call",
        server: "functions",
        tool: "write_stdin",
        arguments: { session_id: 42, chars: "hello\n" },
        result: {
          content: [{
            type: "resource",
            resource: {
              text: "Command: /bin/zsh -lc cat\n\nOutput:\nhello",
            },
          }],
          structured_content: null,
        },
        status: "completed",
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "tool-3",
        name: "write_stdin",
        arguments: { session_id: 42, chars: "hello\n" },
        status: "completed",
        output: "Command: /bin/zsh -lc cat\n\nOutput:\nhello",
      },
    });
  });

  it("normalizes web search events as tool activity", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.started",
      item: {
        id: "web-1",
        type: "web_search",
        query: "time in UTC",
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "web-1",
        name: "WebSearch",
        arguments: { query: "time in UTC" },
        status: "started",
      },
    });
  });

  it("normalizes collab tool call events", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.started",
      item: {
        id: "item_1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        prompt: "Reply with exactly: agent-probe-ok",
        receiver_thread_ids: [],
        agents_states: {},
        status: "in_progress",
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "item_1",
        name: "spawn_agent",
        arguments: { prompt: "Reply with exactly: agent-probe-ok" },
        status: "started",
      },
    });

    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "collab_tool_call",
        tool: "wait",
        prompt: null,
        receiver_thread_ids: ["thread-2"],
        agents_states: {
          "thread-2": {
            status: "completed",
            message: "agent-probe-ok",
          },
        },
        status: "completed",
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "item_2",
        name: "wait_agent",
        arguments: { receiver_thread_ids: ["thread-2"] },
        status: "completed",
        output: "agent-probe-ok",
      },
    });
  });

  it("strips shell wrappers from command displays", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "/bin/zsh -lc \"pnpm type-check\"",
      },
    }), {
      sessionId: null,
      commandEvent: {
        command: "pnpm type-check",
        status: "started",
      },
    });

    assert.deepEqual(normalizeCodexEvent({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "/bin/zsh -lc pwd",
      },
    }), {
      sessionId: null,
      commandEvent: {
        command: "pwd",
        status: "started",
      },
    });
  });

  it("normalizes nested usage on turn completion", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "turn.completed",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 5,
      },
    }), {
      sessionId: null,
      usage: {
        promptTokens: 12,
        completionTokens: 5,
        cachedTokens: 3,
        cost: 0,
      },
    });
  });

  it("normalizes plan and file events", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "plan_update",
        content: [{ text: "step 1" }, { text: "step 2" }],
      },
    }), {
      sessionId: null,
      planText: "step 1\nstep 2",
    });

    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "file_patch",
        path: "src/app.js",
        summary: "updated app",
      },
    }), {
      sessionId: null,
      fileChange: {
        path: "src/app.js",
        summary: "updated app",
      },
    });
  });

  it("preserves diff text when codex emits a file change with patch content", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [{ path: "src/app.js", kind: "update" }],
        patch: [
          "--- a/src/app.js",
          "+++ b/src/app.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      },
    }), {
      sessionId: null,
      fileChange: {
        path: "src/app.js",
        summary: "src/app.js (update)",
        kind: "update",
        diff: [
          "--- a/src/app.js",
          "+++ b/src/app.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      },
    });
  });

  it("unwraps nested error payloads into a usable failure message", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "error",
      message: "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model is not supported.\"}}",
    }), {
      sessionId: null,
      failureMessage: "The model is not supported.",
    });
  });
});
