import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolPresentationFromToolCallEvent,
  renderAgentErrorEvent,
  renderAgentToolResultEvent,
  renderAppMessageEvent,
  renderAssistantOutputEvent,
  renderPlanEvent,
  renderSubagentMessageEvent,
  renderToolActivityEvent,
  renderToolCallEvent,
  renderUsageEvent,
} from "../whatsapp/outbound/event-rendering.js";

describe("semantic outbound event rendering", () => {
  it("renders app messages with transport message sources", () => {
    assert.deepEqual(renderAppMessageEvent({
      kind: "app_message",
      role: "tool_result",
      content: "Session cleared.",
    }), {
      source: "tool-result",
      content: "Session cleared.",
    });
  });

  it("renders assistant output with the llm source and cwd", () => {
    assert.deepEqual(renderAssistantOutputEvent({
      kind: "assistant_output",
      cwd: "/repo",
      content: [{ type: "markdown", text: "Done" }],
    }), {
      source: "llm",
      cwd: "/repo",
      content: [{ type: "markdown", text: "Done" }],
    });
  });

  it("renders agent tool results with the tool-result source and cwd", () => {
    assert.deepEqual(renderAgentToolResultEvent({
      kind: "agent_tool_result",
      cwd: "/repo",
      content: "command output",
    }), {
      source: "tool-result",
      cwd: "/repo",
      content: "command output",
    });
  });

  it("renders agent errors with the error source", () => {
    assert.deepEqual(renderAgentErrorEvent({
      kind: "agent_error",
      message: "Agent runtime failed.",
    }), {
      source: "error",
      content: "Agent runtime failed.",
    });
  });

  it("renders tool call events through transport tool presentation", () => {
    /** @type {ToolCallEvent} */
    const event = {
      kind: "tool_call",
      cwd: "/repo",
      toolCall: {
        id: "call-1",
        name: "Shell",
        arguments: JSON.stringify({ command: "pnpm test" }),
      },
    };

    const presentation = buildToolPresentationFromToolCallEvent(event);
    assert.ok(presentation);

    const rendered = renderToolCallEvent(event);
    assert.equal(rendered?.source, "tool-call");
    assert.match(JSON.stringify(rendered?.content), /pnpm test/);
  });

  it("suppresses empty stdin tool activity", () => {
    assert.equal(renderToolActivityEvent({
      kind: "tool_activity",
      activity: {
        title: "stdin",
        lines: [],
      },
    }), null);
  });

  it("renders plan, usage, and subagent events with named renderers", () => {
    assert.deepEqual(renderPlanEvent({
      kind: "plan",
      presentation: {
        kind: "plan",
        toolName: "update_plan",
        summary: "*Plan*  _All 1 step completed_",
        explanation: null,
        entries: [
          { status: "completed", text: "Extract branches" },
        ],
      },
    }), {
      source: "llm",
      content: [{ type: "markdown", text: "*Plan*\n\n- [x] Extract branches" }],
    });

    assert.deepEqual(renderUsageEvent({
      kind: "usage",
      cost: "$0.01",
      tokens: {
        prompt: 1,
        completion: 2,
        cached: 0,
      },
    }), {
      source: "usage",
      content: "Cost: $0.01 | prompt=1 cached=0 uncached=1 completion=2 cache=0.0%",
    });

    assert.deepEqual(renderSubagentMessageEvent({
      kind: "subagent_message",
      text: "Done",
      agentNickname: "Builder",
      agentRole: "worker",
    }), {
      source: "plain",
      content: [{ type: "markdown", text: "🧩 **Sub-agent Builder**\n_worker_\nDone" }],
    });
  });
});
