import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAcpRuntimeModel, normalizeAcpSessionUpdate } from "../harnesses/acp-events.js";

/**
 * @param {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEventInput | undefined} event
 * @returns {import("../harnesses/harness-runtime-events.js").HarnessRuntimeContentDeltaEvent & import("../harnesses/harness-runtime-events.js").HarnessRuntimeDiagnosticInput}
 */
function requireContentDeltaEvent(event) {
  if (event?.type !== "content.delta") {
    assert.fail(`expected content.delta event, got ${event?.type ?? "none"}`);
  }
  return event;
}

/**
 * @param {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEventInput | undefined} event
 * @returns {import("../harnesses/harness-runtime-events.js").HarnessRuntimeUsageEvent}
 */
function requireUsageEvent(event) {
  if (event?.type !== "usage.updated") {
    assert.fail(`expected usage.updated event, got ${event?.type ?? "none"}`);
  }
  return event;
}

/**
 * @param {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEventInput | undefined} event
 * @returns {import("../harnesses/harness-runtime-events.js").HarnessRuntimeToolEvent}
 */
function requireToolEvent(event) {
  if (
    event?.type !== "tool.started"
    && event?.type !== "tool.updated"
    && event?.type !== "tool.completed"
    && event?.type !== "tool.failed"
  ) {
    assert.fail(`expected tool event, got ${event?.type ?? "none"}`);
  }
  return event;
}

describe("ACP event normalization", () => {
  it("normalizes ACP read display facts onto the canonical tool event", () => {
    const events = normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-real-shape-range",
        title: "Read file",
        kind: "read",
        status: "in_progress",
        rawInput: {
          path: "/repo/src/app.js",
          line: 10,
          limit: 3,
        },
        locations: [{ path: "/repo/src/app.js" }],
      },
    });

    assert.deepEqual(events.map((event) => event.type), ["tool.started"]);
    assert.deepEqual(events[0]?.type === "tool.started" ? events[0].tool : null, {
      id: "read-real-shape-range",
      name: "Read",
      arguments: {
        file_path: "/repo/src/app.js",
        line: 10,
        limit: 3,
      },
    });
  });

  it("marks ACP terminal output delta tools for progress suppression", () => {
    const model = createAcpRuntimeModel();
    model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "terminal-1",
        status: "in_progress",
        kind: "execute",
        rawInput: { command: "rg noisy logs" },
      },
    });
    const events = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "terminal-1",
        status: "in_progress",
        kind: "execute",
        rawInput: { command: "rg noisy logs" },
        rawOutput: { formatted_output: "noisy log chunk" },
        _meta: {
          terminal_output_delta: {
            data: "noisy log chunk",
            terminal_id: "terminal-1",
          },
        },
      },
    });

    assert.deepEqual(events.map((event) => event.type), ["tool.updated"]);
    assert.equal(events[0]?.type === "tool.updated" ? events[0].tool.suppressProgress : false, true);
  });

  it("does not re-emit repeated in-progress tool snapshots as fresh starts", () => {
    const model = createAcpRuntimeModel();
    const first = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu-repeat",
        title: "Run tests",
        status: "in_progress",
      },
    });
    const second = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu-repeat",
        title: "Run tests",
        status: "in_progress",
      },
    });

    assert.deepEqual(first.map((event) => event.type), ["tool.started"]);
    assert.deepEqual(second.map((event) => event.type), ["tool.updated"]);
  });

  it("does not complete assistant chunks just because a running tool updates", () => {
    const model = createAcpRuntimeModel();
    const first = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "test-run",
        title: "pnpm test",
        kind: "execute",
        status: "in_progress",
      },
    });
    const chunk = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The full " },
      },
    });
    const update = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "test-run",
        status: "in_progress",
      },
    });
    const secondChunk = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "test runner is underway." },
      },
    });
    const flushed = model.flushAssistantSegment();

    assert.deepEqual(first.map((event) => event.type), ["tool.started"]);
    assert.deepEqual(chunk.map((event) => event.type), ["item.started", "content.delta"]);
    assert.deepEqual(update.map((event) => event.type), ["tool.updated"]);
    assert.deepEqual(secondChunk.map((event) => event.type), ["content.delta"]);
    assert.deepEqual(flushed.map((event) => event.type), ["item.completed"]);
    assert.equal(flushed[0]?.type === "item.completed" ? flushed[0].item.text : "", "The full test runner is underway.");
  });

  it("normalizes assistant text, plans, and tool lifecycle updates", () => {
    const assistantEvents = normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      },
    });
    assert.deepEqual(assistantEvents.map((event) => event.type), ["item.started", "content.delta"]);
    const assistantDelta = requireContentDeltaEvent(assistantEvents[1]);
    assert.equal(assistantDelta.provider, "acp");
    assert.equal(assistantDelta.text, "Done.");
    assert.equal(assistantDelta.contentType, "markdown");
    assert.deepEqual(assistantDelta.diagnosticRaw?.payload, {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      },
    });

    const planEvents = normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Read code", status: "completed" },
          { content: "Patch ACP", status: "in_progress" },
        ],
      },
    });
    assert.deepEqual(planEvents, [{
      type: "plan.updated",
      provider: "acp",
      plan: {
        explanation: null,
        entries: [
          { text: "Read code", status: "completed" },
          { text: "Patch ACP", status: "in_progress" },
        ],
      },
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Read code", status: "completed" },
              { content: "Patch ACP", status: "in_progress" },
            ],
          },
        },
      },
    }]);

    const toolEvents = normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu-1",
        title: "Review the database layer",
        kind: "think",
        rawInput: {
          prompt: "Audit migrations",
          subagent_type: "code-reviewer",
        },
        status: "in_progress",
      },
    });

    assert.deepEqual(toolEvents, [{
      type: "tool.started",
      provider: "acp",
      tool: {
        id: "toolu-1",
        name: "Task",
        arguments: {
          title: "Review the database layer",
          prompt: "Audit migrations",
          subagent_type: "code-reviewer",
        },
      },
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "toolu-1",
            title: "Review the database layer",
            kind: "think",
            rawInput: {
              prompt: "Audit migrations",
              subagent_type: "code-reviewer",
            },
            status: "in_progress",
          },
        },
      },
    }]);
  });

  it("normalizes Guardian approval review text as a runtime warning instead of assistant output", () => {
    const events = normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Guardian warning: Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.\n\n",
        },
      },
    });

    assert.deepEqual(events.map((event) => event.type), ["runtime.warning"]);
    const [event] = events;
    assert.equal(event?.type === "runtime.warning" ? event.summary : "", "Automatic approval review approved");
    assert.equal(event?.type === "runtime.warning" ? event.class : "", "permission_error");
    assert.equal(
      event?.type === "runtime.warning" ? event.message?.startsWith("Guardian warning: Automatic approval review approved") : false,
      true,
    );
  });

  it("normalizes Madabot ACP subagent messages and ACP diff content", () => {
    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The migration has a rollback bug." },
        _meta: { madabot: { subagent: { threadId: "toolu-task-1", agentNickname: "Reviewer" } } },
      },
    }), [{
      type: "subagent.completed",
      provider: "acp",
      text: "The migration has a rollback bug.",
      metadata: {
        source: "subagent",
        threadId: "toolu-task-1",
        agentNickname: "Reviewer",
      },
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The migration has a rollback bug." },
            _meta: { madabot: { subagent: { threadId: "toolu-task-1", agentNickname: "Reviewer" } } },
          },
        },
      },
    }]);

    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        title: "Edited app.js",
        status: "completed",
        content: [{
          type: "diff",
          path: "app.js",
          oldText: "old",
          newText: "new",
        }],
      },
    }), [{
      type: "tool.completed",
      provider: "acp",
      tool: {
        id: "edit-1",
        name: "Edited app.js",
        arguments: {},
        output: "app.js",
      },
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "edit-1",
            title: "Edited app.js",
            status: "completed",
            content: [{
              type: "diff",
              path: "app.js",
              oldText: "old",
              newText: "new",
            }],
          },
        },
      },
    }, {
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: "app.js",
        kind: "update",
        source: "tool",
        summary: "Edited app.js",
        oldText: "old",
        newText: "new",
      },
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "edit-1",
            title: "Edited app.js",
            status: "completed",
            content: [{
              type: "diff",
              path: "app.js",
              oldText: "old",
              newText: "new",
            }],
          },
        },
      },
    }]);
  });

  it("normalizes ACP session usage RFD updates", () => {
    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "usage_update",
        used: 53,
        size: 200,
        cost: { amount: 0.045, currency: "USD" },
      },
    }), [{
      type: "usage.updated",
      provider: "acp",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 53,
        cost: 0.045,
        contextWindow: 200,
      },
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "usage_update",
            used: 53,
            size: 200,
            cost: { amount: 0.045, currency: "USD" },
          },
        },
      },
    }]);
  });

  it("normalizes Codex ACP camelCase prompt usage", () => {
    const [event] = normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "usage_update",
        totalTokens: 14775,
        inputTokens: 3617,
        cachedReadTokens: 11136,
        outputTokens: 22,
        thoughtTokens: 12,
        contextWindow: 200000,
      },
    });
    assert.deepEqual(requireUsageEvent(event).usage, {
      promptTokens: 3617,
      completionTokens: 22,
      cachedTokens: 11136,
      cost: 0,
      totalTokens: 14775,
      reasoningTokens: 12,
      contextWindow: 200000,
    });
  });

  it("normalizes provider-native warnings, model reroutes, and runtime errors", () => {
    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "config_warning",
        summary: "Invalid MCP server",
        details: "Missing command",
        path: "/repo/.codex/config.toml",
      },
    }), [{
      type: "config.warning",
      provider: "acp",
      summary: "Invalid MCP server",
      details: "Missing command",
      path: "/repo/.codex/config.toml",
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "config_warning",
            summary: "Invalid MCP server",
            details: "Missing command",
            path: "/repo/.codex/config.toml",
          },
        },
      },
    }]);

    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "model_rerouted",
        fromModel: "gpt-5.4",
        toModel: "gpt-5.4-mini",
        reason: "capacity",
      },
    })[0], {
      type: "model.rerouted",
      provider: "acp",
      fromModel: "gpt-5.4",
      toModel: "gpt-5.4-mini",
      reason: "capacity",
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionId: "s1",
          update: {
            sessionUpdate: "model_rerouted",
            fromModel: "gpt-5.4",
            toModel: "gpt-5.4-mini",
            reason: "capacity",
          },
        },
      },
    });

    assert.equal(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "runtime_error",
        message: "Provider exited",
      },
    })[0]?.type, "runtime.error");
  });

  it("merges partial ACP tool updates before emitting completed tools", () => {
    const model = createAcpRuntimeModel();
    model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "edit-2",
        title: "Edit app.js",
        rawInput: { path: "app.js" },
        status: "in_progress",
      },
    });
    const completed = model.acceptSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-2",
        status: "completed",
        content: [{ type: "text", text: "ok" }],
      },
    });
    assert.deepEqual(requireToolEvent(completed[0]).tool, {
      id: "edit-2",
      name: "Edit app.js",
      arguments: { path: "app.js" },
      output: "ok",
    });
  });
});
