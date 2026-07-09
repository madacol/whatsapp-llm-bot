import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentRunOutputPort } from "../agent-run-output-port.js";

/**
 * @returns {{
 *   context: ExecuteActionContext,
 *   sent: Array<{ via: "send" | "reply", event: OutboundEvent }>,
 * }}
 */
function createSubject() {
  /** @type {Array<{ via: "send" | "reply", event: OutboundEvent }>} */
  const sent = [];
  const context = /** @type {ExecuteActionContext} */ ({
    chatId: "chat-1",
    senderIds: [],
    senderJids: [],
    content: [],
    getIsAdmin: async () => true,
    send: async (event) => {
      sent.push({ via: "send", event });
      return undefined;
    },
    reply: async (event) => {
      sent.push({ via: "reply", event });
      return undefined;
    },
    reactToMessage: async () => {},
    select: async () => "",
    selectMany: async () => ({ kind: "cancelled" }),
    confirm: async () => true,
  });
  return { context, sent };
}

describe("createAgentRunOutputPort", () => {
  it("creates agent-run output events through semantic methods", async () => {
    const { context, sent } = createSubject();
    const agentOutput = createAgentRunOutputPort(context, { cwd: "/repo" });

    await agentOutput.sendRuntimeEvent({
      type: "command.started",
      provider: "codex",
      command: { command: "pnpm test", status: "started" },
    });
    await agentOutput.replyWithAssistantOutput([{ type: "markdown", text: "Done" }]);
    await agentOutput.replyWithError("Agent failed.");
    await agentOutput.sendUsage("0.000001", { prompt: 1, completion: 2, cached: 0 });

    assert.deepEqual(sent, [
      {
        via: "send",
        event: {
          kind: "runtime_event",
          cwd: "/repo",
          event: {
            type: "command.started",
            provider: "codex",
            command: { command: "pnpm test", status: "started" },
          },
        },
      },
      {
        via: "reply",
        event: {
          kind: "assistant_output",
          cwd: "/repo",
          content: [{ type: "markdown", text: "Done" }],
        },
      },
      {
        via: "reply",
        event: {
          kind: "agent_error",
          message: "Agent failed.",
        },
      },
      {
        via: "send",
        event: {
          kind: "usage",
          cost: "0.000001",
          tokens: { prompt: 1, completion: 2, cached: 0 },
        },
      },
    ]);
  });

  it("does not expose app-owned reply methods", () => {
    const { context } = createSubject();
    const agentOutput = createAgentRunOutputPort(context);

    assert.equal("replyWithToolResult" in agentOutput, false);
    assert.equal("replyWithPlain" in agentOutput, false);
  });

  it("emits agent-owned error events instead of app messages", async () => {
    const { context, sent } = createSubject();
    const agentOutput = createAgentRunOutputPort(context);

    await agentOutput.sendError("Tool loop failed.");

    assert.deepEqual(sent, [
      {
        via: "send",
        event: {
          kind: "agent_error",
          message: "Tool loop failed.",
        },
      },
    ]);
  });

  it("emits semantic agent tool result events instead of generic content", async () => {
    const { context, sent } = createSubject();
    const agentOutput = createAgentRunOutputPort(context, { cwd: "/repo" });

    await agentOutput.sendToolResult("command output");

    assert.deepEqual(sent, [
      {
        via: "send",
        event: {
          kind: "agent_tool_result",
          cwd: "/repo",
          content: "command output",
        },
      },
    ]);
  });
});
