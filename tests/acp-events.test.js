import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAcpRuntimeModel, normalizeAcpSessionUpdate } from "../harnesses/acp-events.js";

describe("ACP event normalization", () => {
  it("normalizes assistant text, plans, and tool lifecycle updates", () => {
    const assistantEvents = normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      },
    });
    assert.deepEqual(assistantEvents.map((event) => event.type), ["item.started", "content.delta"]);
    assert.equal(assistantEvents[1]?.provider, "acp");
    assert.equal(assistantEvents[1]?.text, "Done.");
    assert.equal(assistantEvents[1]?.contentType, "markdown");
    assert.deepEqual(assistantEvents[1]?.raw?.payload, {
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
      raw: {
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
      raw: {
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
      raw: {
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
      raw: {
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
        summary: "Edited app.js",
        oldText: "old",
        newText: "new",
      },
      raw: {
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
      raw: {
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
    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "usage_update",
        totalTokens: 14775,
        inputTokens: 3617,
        cachedReadTokens: 11136,
        outputTokens: 22,
        thoughtTokens: 12,
      },
    })[0]?.usage, {
      promptTokens: 3617,
      completionTokens: 22,
      cachedTokens: 11136,
      cost: 0,
      totalTokens: 14775,
      reasoningTokens: 12,
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
      raw: {
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
      raw: {
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
    assert.deepEqual(completed[0]?.tool, {
      id: "edit-2",
      name: "Edit app.js",
      arguments: { path: "app.js" },
      output: "ok",
    });
  });
});
