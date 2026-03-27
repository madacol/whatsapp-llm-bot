import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexSessionId,
  extractCodexText,
  normalizeCodexAppServerEvent,
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

  it("normalizes reasoning items from SDK events", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.started",
      item: {
        id: "reason-1",
        type: "reasoning",
        text: "",
      },
    }), {
      sessionId: null,
      reasoningEvent: {
        itemId: "reason-1",
        status: "started",
        summarySnapshot: [],
        contentSnapshot: [],
      },
    });

    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "reason-1",
        type: "reasoning",
        text: "Plan the edit, then patch the file.",
      },
    }), {
      sessionId: null,
      reasoningEvent: {
        itemId: "reason-1",
        status: "completed",
        summarySnapshot: [],
        contentSnapshot: ["Plan the edit, then patch the file."],
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

  it("normalizes todo_list items as update_plan tool activity", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.started",
      item: {
        id: "todo-1",
        type: "todo_list",
        items: [
          { text: "Initialize requested plan state", completed: true },
        ],
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "todo-1",
        name: "update_plan",
        arguments: {
          items: [
            { text: "Initialize requested plan state", completed: true },
          ],
        },
        status: "started",
      },
    });

    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "todo-1",
        type: "todo_list",
        items: [
          { text: "Initialize requested plan state", completed: true },
        ],
      },
    }), {
      sessionId: null,
      toolEvent: {
        id: "todo-1",
        name: "update_plan",
        arguments: {
          items: [
            { text: "Initialize requested plan state", completed: true },
          ],
        },
        status: "completed",
        output: "Initialize requested plan state",
      },
    });
  });

  it("normalizes reasoning items from app-server events", () => {
    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "item/started",
      params: {
        threadId: "thread-1",
        item: {
          id: "reason-2",
          type: "reasoning",
          summary: [],
          content: [],
        },
      },
    }), {
      sessionId: "thread-1",
      reasoningEvent: {
        itemId: "reason-2",
        status: "started",
        summarySnapshot: [],
        contentSnapshot: [],
      },
    });

    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "reason-2",
          type: "reasoning",
          summary: ["Summarize the approach before replying."],
          content: [],
        },
      },
    }), {
      sessionId: "thread-1",
      reasoningEvent: {
        itemId: "reason-2",
        status: "completed",
        summarySnapshot: ["Summarize the approach before replying."],
        contentSnapshot: [],
      },
    });

    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Summarize the approach before replying." }],
          content: null,
          encrypted_content: "gAAAAA...",
        },
      },
    }), {
      sessionId: "thread-1",
      reasoningEvent: {
        status: "updated",
        summarySnapshot: ["Summarize the approach before replying."],
        contentSnapshot: [],
        hasEncryptedContent: true,
      },
    });

    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "item/reasoning/summaryPartAdded",
      params: {
        threadId: "thread-1",
        itemId: "reason-2",
        summaryIndex: 0,
      },
    }), {
      sessionId: "thread-1",
      reasoningEvent: {
        itemId: "reason-2",
        status: "updated",
        summaryDelta: {
          index: 0,
          text: "",
        },
      },
    });

    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1",
        itemId: "reason-2",
        summaryIndex: 0,
        delta: "Summarize the approach before replying.",
      },
    }), {
      sessionId: "thread-1",
      reasoningEvent: {
        itemId: "reason-2",
        status: "updated",
        summaryDelta: {
          index: 0,
          text: "Summarize the approach before replying.",
        },
      },
    });

    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1",
        itemId: "reason-2",
        contentIndex: 0,
        delta: "Inspect the file, then patch the bug.",
      },
    }), {
      sessionId: "thread-1",
      reasoningEvent: {
        itemId: "reason-2",
        status: "updated",
        contentDelta: {
          index: 0,
          text: "Inspect the file, then patch the bug.",
        },
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

  it("expands multi-file file_change payloads into separate normalized file changes", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [
          { path: "src/add.js", kind: "add" },
          { path: "src/update.js", kind: "update" },
          { path: "src/delete.js", kind: "delete" },
        ],
      },
    }), {
      sessionId: null,
      fileChanges: [
        {
          path: "src/add.js",
          summary: "src/add.js (add)",
          kind: "add",
        },
        {
          path: "src/update.js",
          summary: "src/update.js (update)",
          kind: "update",
        },
        {
          path: "src/delete.js",
          summary: "src/delete.js (delete)",
          kind: "delete",
        },
      ],
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

  it("normalizes Codex App Server steerable web search events", () => {
    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "item/started",
      params: {
        threadId: "thr_123",
        item: {
          id: "web_1",
          type: "webSearch",
          action: {
            type: "openPage",
            url: "https://example.com/page",
          },
        },
      },
    }), {
      sessionId: "thr_123",
      toolEvent: {
        id: "web_1",
        name: "open",
        arguments: {
          open: [{ ref_id: "https://example.com/page" }],
        },
        status: "started",
      },
    });
  });

  it("normalizes Codex App Server turn steering plan updates", () => {
    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "turn/plan/updated",
      params: {
        threadId: "thr_123",
        turnId: "turn_456",
        explanation: "Replanning around user steer.",
        plan: [
          { step: "Read failing test", status: "inProgress" },
          { step: "Patch issue", status: "pending" },
        ],
      },
    }), {
      sessionId: "thr_123",
      planText: "Replanning around user steer.\nRead failing test\nPatch issue",
    });
  });

  it("normalizes Codex App Server nested token usage updates", () => {
    assert.deepEqual(normalizeCodexAppServerEvent({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr_123",
        turnId: "turn_456",
        tokenUsage: {
          total: {
            totalTokens: 12246,
            inputTokens: 12227,
            cachedInputTokens: 9600,
            outputTokens: 19,
            reasoningOutputTokens: 12,
          },
          last: {
            totalTokens: 12246,
            inputTokens: 12227,
            cachedInputTokens: 9600,
            outputTokens: 19,
            reasoningOutputTokens: 12,
          },
          modelContextWindow: 258400,
        },
      },
    }), {
      sessionId: "thr_123",
      usage: {
        promptTokens: 12227,
        completionTokens: 19,
        cachedTokens: 9600,
        cost: 0,
      },
    });
  });
});
