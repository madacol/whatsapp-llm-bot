import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAcpSessionUpdate } from "../harnesses/acp-events.js";

describe("ACP event normalization", () => {
  it("normalizes assistant text, plans, and tool lifecycle updates", () => {
    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      },
    }), [{
      type: "assistant.completed",
      provider: "acp",
      text: "Done.",
      displayText: "Done.",
      contentType: "markdown",
      responseMode: "append",
      raw: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        },
      },
    }]);

    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Read code", status: "completed" },
          { content: "Patch ACP", status: "in_progress" },
        ],
      },
    }), [{
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
        sessionId: "s1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read code", status: "completed" },
            { content: "Patch ACP", status: "in_progress" },
          ],
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
    }]);
  });

  it("normalizes Claude ACP subagent messages and ACP diff content", () => {
    assert.deepEqual(normalizeAcpSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The migration has a rollback bug." },
        _meta: {
          claudeCode: {
            parentToolUseId: "toolu-task-1",
          },
        },
      },
    }), [{
      type: "subagent.completed",
      provider: "acp",
      text: "The migration has a rollback bug.",
      metadata: {
        source: "subagent",
        threadId: "toolu-task-1",
      },
      raw: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The migration has a rollback bug." },
          _meta: {
            claudeCode: {
              parentToolUseId: "toolu-task-1",
            },
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
        cost: 0.045,
        contextWindow: 200,
      },
      raw: {
        sessionId: "s1",
        update: {
          sessionUpdate: "usage_update",
          used: 53,
          size: 200,
          cost: { amount: 0.045, currency: "USD" },
        },
      },
    }]);
  });
});
