import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSharedSkillInvocationAdapter,
  executeSharedSkillInvocations,
  parseSharedSkillInvocation,
} from "../shared-skill-runtime.js";

describe("parseSharedSkillInvocation", () => {
  it("parses a fenced madabot skill invocation", () => {
    const parsed = parseSharedSkillInvocation([
      "```madabot-skill",
      "{\"skill\":\"send-path\",\"arguments\":{\"path\":\"./chart.png\"}}",
      "```",
    ].join("\n"));

    assert.deepEqual(parsed, {
      skill: "send-path",
      arguments: { path: "./chart.png" },
      raw: [
        "```madabot-skill",
        "{\"skill\":\"send-path\",\"arguments\":{\"path\":\"./chart.png\"}}",
        "```",
      ].join("\n"),
    });
  });

  it("returns null for normal assistant text", () => {
    assert.equal(parseSharedSkillInvocation("Here is your answer."), null);
  });
});

describe("createSharedSkillInvocationAdapter", () => {
  it("suppresses invocation text and remembers it once", () => {
    const adapter = createSharedSkillInvocationAdapter();
    const text = [
      "```madabot-skill",
      "{\"skill\":\"send-path\",\"arguments\":{\"path\":\"./chart.png\"}}",
      "```",
    ].join("\n");

    assert.equal(adapter.handleText(text), true);
    assert.equal(adapter.handleText(text), true);
    assert.deepEqual(adapter.drainInvocations(), [{
      skill: "send-path",
      arguments: { path: "./chart.png" },
      raw: text,
    }]);
    assert.deepEqual(adapter.drainInvocations(), []);
  });
});

describe("executeSharedSkillInvocations", () => {
  it("maps a shared skill to its native action and emits the tool result", async () => {
    /** @type {Array<{ name: string, params: Record<string, unknown> }>} */
    const executed = [];
    /** @type {ToolContentBlock[][]} */
    const toolResults = [];
    /** @type {string[]} */
    const toolCalls = [];
    /** @type {Message[]} */
    const messages = [];
    /** @type {Message[]} */
    const persistedMessages = [];

    const blocks = /** @type {ToolContentBlock[]} */ ([
      { type: "image", path: "abc.png", mime_type: "image/png" },
    ]);

    const result = await executeSharedSkillInvocations([{
      skill: "send-path",
      arguments: { path: "./chart.png" },
      raw: [
        "```madabot-skill",
        "{\"skill\":\"send-path\",\"arguments\":{\"path\":\"./chart.png\"}}",
        "```",
      ].join("\n"),
    }], {
      toolRuntime: /** @type {ToolRuntime} */ ({
        listTools: () => [{
          name: "send_path",
          description: "Send a path",
          sharedSkill: {
            name: "send-path",
            instructions: "Return a file.",
          },
          parameters: { type: "object", properties: {} },
          permissions: {},
        }],
        getTool: async () => null,
        executeTool: async (toolName, _context, params) => {
          executed.push({ name: toolName, params });
          return { result: blocks, permissions: {} };
        },
      }),
      session: /** @type {Session} */ ({
        chatId: "chat-1",
        senderIds: [],
        context: /** @type {ExecuteActionContext} */ ({
          chatId: "chat-1",
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async () => undefined,
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        addMessage: async (_chatId, message) => {
          persistedMessages.push(message);
          return null;
        },
        updateToolMessage: async () => null,
      }),
      hooks: {
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall.name);
          return undefined;
        },
        onToolResult: async (resultBlocks) => {
          toolResults.push(resultBlocks);
        },
        onToolError: async () => {},
      },
      messages,
      runConfig: undefined,
    });

    assert.deepEqual(executed, [{
      name: "send_path",
      params: { path: "./chart.png" },
    }]);
    assert.deepEqual(toolCalls, ["send_path"]);
    assert.deepEqual(toolResults, [blocks]);
    assert.deepEqual(result, blocks);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "tool");
    assert.equal(persistedMessages.length, 1);
    assert.equal(persistedMessages[0]?.role, "tool");
  });
});
