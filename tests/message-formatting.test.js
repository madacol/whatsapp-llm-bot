import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  actionsToOpenAIFormat,
  shouldRespond,
  formatUserMessage,
  parseCommandArgs,
  formatMessagesForOpenAI,
} from "../message-formatting.js";

// ── actionsToOpenAIFormat ──

describe("actionsToOpenAIFormat", () => {
  it("maps name, description, parameters correctly", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "test_action",
        description: "A test action",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    ]);
    const result = actionsToOpenAIFormat(actions);

    assert.equal(result.length, 1);
    assert.equal(result[0].type, "function");
    assert.equal(result[0].function.name, "test_action");
    assert.equal(result[0].function.description, "A test action");
    assert.deepEqual(result[0].function.parameters, actions[0].parameters);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(actionsToOpenAIFormat([]), []);
  });
});

// ── shouldRespond ──

describe("shouldRespond", () => {
  it("returns false when chat is disabled", () => {
    assert.equal(shouldRespond({ is_enabled: false }, false, [], [], undefined), false);
  });

  it("returns false when chatInfo is undefined", () => {
    assert.equal(shouldRespond(undefined, false, [], [], undefined), false);
  });

  it("returns true for enabled private chat", () => {
    assert.equal(
      shouldRespond({ is_enabled: true }, false, [{ type: "text", text: "hi" }], ["bot"], undefined),
      true,
    );
  });

  it("returns true for group when bot is mentioned (default: respond_on_mention=true)", () => {
    assert.equal(
      shouldRespond(
        { is_enabled: true },
        true,
        [{ type: "text", text: "hey @bot-123 what's up" }],
        ["bot-123"],
        undefined,
      ),
      true,
    );
  });

  it("returns false for group when bot is not mentioned and no reply (default)", () => {
    assert.equal(
      shouldRespond(
        { is_enabled: true },
        true,
        [{ type: "text", text: "hello everyone" }],
        ["bot-123"],
        undefined,
      ),
      false,
    );
  });

  it("returns true when one of multiple selfIds is mentioned", () => {
    assert.equal(
      shouldRespond(
        { is_enabled: true },
        true,
        [{ type: "text", text: "hey @alt-id" }],
        ["bot-123", "alt-id"],
        undefined,
      ),
      true,
    );
  });

  describe("respond_on_any: true", () => {
    it("responds to any message in group", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_any: true },
          true,
          [{ type: "text", text: "hello everyone" }],
          ["bot-123"],
          undefined,
        ),
        true,
      );
    });

    it("works alongside other options", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_any: true, respond_on_mention: false, respond_on_reply: false },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          undefined,
        ),
        true,
      );
    });
  });

  describe("respond_on_mention: false", () => {
    it("does not respond to mentions when disabled", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_mention: false },
          true,
          [{ type: "text", text: "@bot-123 hello" }],
          ["bot-123"],
          undefined,
        ),
        false,
      );
    });
  });

  describe("respond_on_reply: true", () => {
    it("responds when message is a reply to bot", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_reply: true },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          "bot-123",
        ),
        true,
      );
    });

    it("does not respond when reply is to someone else", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_reply: true },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          "other-user",
        ),
        false,
      );
    });

    it("does not respond when no reply context", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_reply: true },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          undefined,
        ),
        false,
      );
    });
  });

  describe("both respond_on_mention and respond_on_reply enabled", () => {
    it("responds to mention", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_mention: true, respond_on_reply: true },
          true,
          [{ type: "text", text: "@bot-123 hello" }],
          ["bot-123"],
          undefined,
        ),
        true,
      );
    });

    it("responds to reply", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_mention: true, respond_on_reply: true },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          "bot-123",
        ),
        true,
      );
    });
  });

  describe("both disabled", () => {
    it("does not respond even when mentioned", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_mention: false, respond_on_reply: false },
          true,
          [{ type: "text", text: "@bot-123 hello" }],
          ["bot-123"],
          undefined,
        ),
        false,
      );
    });

    it("does not respond even when reply to bot", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on_mention: false, respond_on_reply: false },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          "bot-123",
        ),
        false,
      );
    });
  });
});

// ── formatUserMessage ──

describe("formatUserMessage", () => {
  it("formats private message with timestamp", () => {
    const block = /** @type {TextContentBlock} */ ({ type: "text", text: "hello" });
    const { formattedText, systemPromptSuffix } = formatUserMessage(
      block, false, "User", "01/01/2025, 12:00", ["bot"],
    );
    assert.equal(formattedText, "[01/01/2025, 12:00] hello");
    assert.equal(systemPromptSuffix, "");
  });

  it("formats group message with sender name", () => {
    const block = /** @type {TextContentBlock} */ ({ type: "text", text: "hello" });
    const { formattedText, systemPromptSuffix } = formatUserMessage(
      block, true, "Alice", "01/01/2025, 12:00", ["bot"],
    );
    assert.equal(formattedText, "[01/01/2025, 12:00] Alice: hello");
    assert.ok(systemPromptSuffix.includes("group chat"));
  });

  it("strips mention of self from start of group message", () => {
    const block = /** @type {TextContentBlock} */ ({ type: "text", text: "@bot hello" });
    const { formattedText } = formatUserMessage(
      block, true, "Alice", "01/01/2025, 12:00", ["bot"],
    );
    assert.equal(formattedText, "[01/01/2025, 12:00] Alice: hello");
  });

  it("strips any of multiple selfIds from start", () => {
    const block = /** @type {TextContentBlock} */ ({ type: "text", text: "@alt-id hello" });
    const { formattedText } = formatUserMessage(
      block, true, "Alice", "01/01/2025, 12:00", ["bot", "alt-id"],
    );
    assert.equal(formattedText, "[01/01/2025, 12:00] Alice: hello");
  });
});

// ── parseCommandArgs ──

describe("parseCommandArgs", () => {
  it("maps positional args to param names", () => {
    const params = parseCommandArgs(["hello", "world"], {
      type: "object",
      properties: {
        greeting: { type: "string" },
        target: { type: "string" },
      },
    });
    assert.deepEqual(params, { greeting: "hello", target: "world" });
  });

  it("uses default values for missing args", () => {
    const params = parseCommandArgs([], {
      type: "object",
      properties: {
        name: { type: "string", default: "fallback" },
      },
    });
    assert.deepEqual(params, { name: "fallback" });
  });

  it("returns undefined for missing args without defaults", () => {
    const params = parseCommandArgs([], {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
    assert.equal(params.name, undefined);
  });
});

// ── formatMessagesForOpenAI ──

describe("formatMessagesForOpenAI", () => {
  it("converts user text message", () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        sender_id: "user-1",
      },
    ];
    const result = formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
    assert.deepEqual(result[0].content, [{ type: "text", text: "hello" }]);
  });

  it("converts user image message to image_url", () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [
            { type: "image", mime_type: "image/png", data: "abc123", encoding: "base64" },
          ],
        },
        sender_id: "user-1",
      },
    ];
    const result = formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].type, "image_url");
    assert.equal(content[0].image_url.url, "data:image/png;base64,abc123");
  });

  it("converts user quote message with > prefix", () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [
            {
              type: "quote",
              content: [{ type: "text", text: "quoted text" }],
            },
          ],
        },
        sender_id: "user-1",
      },
    ];
    const result = formatMessagesForOpenAI(messages);

    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].type, "text");
    assert.ok(content[0].text.startsWith("> quoted text"));
  });

  it("converts assistant message with tool calls", () => {
    const messages = [
      {
        message_data: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help" },
            {
              type: "tool",
              tool_id: "call_123",
              name: "run_javascript",
              arguments: '{"code": "1+1"}',
            },
          ],
        },
        sender_id: "bot",
      },
    ];
    const result = formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "assistant");
    const msg = /** @type {any} */ (result[0]);
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, "run_javascript");
  });

  it("converts tool result message (after an assistant with tool_calls)", () => {
    // A tool result only appears after an assistant message with tool_calls.
    // A lone tool result at the start would be stripped as a "leading tool result".
    const messages = [
      {
        message_data: {
          role: "tool",
          tool_id: "call_123",
          content: [{ type: "text", text: "result" }],
        },
        sender_id: "bot",
      },
      {
        message_data: {
          role: "assistant",
          content: [
            { type: "tool", tool_id: "call_123", name: "test_fn", arguments: "{}" },
          ],
        },
        sender_id: "bot",
      },
    ];
    // Input is newest-first; after reverse: assistant, then tool
    const result = formatMessagesForOpenAI(messages);

    assert.equal(result.length, 2);
    const toolMsg = result.find(m => m.role === "tool");
    assert.ok(toolMsg);
    const msg = /** @type {any} */ (toolMsg);
    assert.equal(msg.tool_call_id, "call_123");
    assert.equal(msg.content, "result");
  });

  it("strips leading tool results from message list", () => {
    const messages = [
      // newest first (before reverse)
      {
        message_data: { role: "user", content: [{ type: "text", text: "hello" }] },
        sender_id: "user-1",
      },
      {
        message_data: { role: "tool", tool_id: "c1", content: [{ type: "text", text: "res" }] },
        sender_id: "bot",
      },
    ];
    // After reverse: tool first, then user. Tool should be stripped.
    const result = formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
  });
});
