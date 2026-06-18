import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderAgentToolResultEvent,
  renderAppMessageEvent,
  renderAssistantOutputEvent,
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
});
