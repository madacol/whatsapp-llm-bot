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

  it("returns true for group when bot is mentioned (default: respond_on=mention)", () => {
    assert.equal(
      shouldRespond(
        { is_enabled: true, respond_on: "mention" },
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
        { is_enabled: true, respond_on: "mention" },
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
        { is_enabled: true, respond_on: "mention" },
        true,
        [{ type: "text", text: "hey @alt-id" }],
        ["bot-123", "alt-id"],
        undefined,
      ),
      true,
    );
  });

  describe("respond_on: any", () => {
    it("responds to any message in group", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on: "any" },
          true,
          [{ type: "text", text: "hello everyone" }],
          ["bot-123"],
          undefined,
        ),
        true,
      );
    });
  });

  describe("respond_on: mention", () => {
    it("responds to mentions", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on: "mention" },
          true,
          [{ type: "text", text: "@bot-123 hello" }],
          ["bot-123"],
          undefined,
        ),
        true,
      );
    });

    it("does not respond to reply when mode is mention only", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on: "mention" },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          "bot-123",
        ),
        false,
      );
    });

    it("does not respond when not mentioned", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on: "mention" },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          undefined,
        ),
        false,
      );
    });
  });

  describe("respond_on: mention+reply", () => {
    it("responds to mention", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on: "mention+reply" },
          true,
          [{ type: "text", text: "@bot-123 hello" }],
          ["bot-123"],
          undefined,
        ),
        true,
      );
    });

    it("responds to reply to bot", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on: "mention+reply" },
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
          { is_enabled: true, respond_on: "mention+reply" },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          "other-user",
        ),
        false,
      );
    });

    it("does not respond when no mention and no reply context", () => {
      assert.equal(
        shouldRespond(
          { is_enabled: true, respond_on: "mention+reply" },
          true,
          [{ type: "text", text: "hello" }],
          ["bot-123"],
          undefined,
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
  it("joins remaining args for the last parameter", () => {
    const params = parseCommandArgs(["You", "are", "a", "helpful", "bot"], {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
    });
    assert.equal(params.prompt, "You are a helpful bot");
  });

  it("joins remaining args only for the last param when multiple params exist", () => {
    const params = parseCommandArgs(["key1", "hello", "world", "!"], {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
    });
    assert.equal(params.key, "key1");
    assert.equal(params.value, "hello world !");
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
  it("converts user text message", async () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        sender_id: "user-1",
      },
    ];
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
    assert.deepEqual(result[0].content, [{ type: "text", text: "hello" }]);
  });

  it("converts user image message to image_url", async () => {
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
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].type, "image_url");
    assert.equal(content[0].image_url.url, "data:image/png;base64,abc123");
  });

  it("converts user quote message with > prefix", async () => {
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
    const result = await formatMessagesForOpenAI(messages);

    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].type, "text");
    assert.ok(content[0].text.startsWith("> quoted text"));
  });

  it("converts assistant message with tool calls", async () => {
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
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "assistant");
    const msg = /** @type {import("openai").default.ChatCompletionAssistantMessageParam} */ (result[0]);
    assert.ok(msg.tool_calls);
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, "run_javascript");
  });

  it("converts tool result message (after an assistant with tool_calls)", async () => {
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
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 2);
    const toolMsg = result.find(m => m.role === "tool");
    assert.ok(toolMsg);
    const msg = /** @type {import("openai").default.ChatCompletionToolMessageParam} */ (toolMsg);
    assert.equal(msg.tool_call_id, "call_123");
    assert.equal(msg.content, "result");
  });

  it("does not mutate the input array", async () => {
    const messages = [
      {
        message_data: { role: "user", content: [{ type: "text", text: "first" }] },
        sender_id: "user-1",
      },
      {
        message_data: { role: "user", content: [{ type: "text", text: "second" }] },
        sender_id: "user-1",
      },
    ];
    const originalFirst = messages[0];
    await formatMessagesForOpenAI(messages);

    assert.strictEqual(messages[0], originalFirst, "input array should not be reversed");
    assert.equal(messages.length, 2, "input array length should not change");
  });

  it("handles audio message with wav mime_type", async () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [
            { type: "audio", encoding: "base64", mime_type: "audio/wav", data: "abc123" },
          ],
        },
        sender_id: "user-1",
      },
    ];
    const result = await formatMessagesForOpenAI(messages);
    assert.equal(result.length, 1);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].type, "input_audio");
    assert.equal(content[0].input_audio.format, "wav");
    assert.equal(content[0].input_audio.data, "abc123");
  });

  it("handles audio message with mp3 mime_type", async () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [
            { type: "audio", encoding: "base64", mime_type: "audio/mp3", data: "def456" },
          ],
        },
        sender_id: "user-1",
      },
    ];
    const result = await formatMessagesForOpenAI(messages);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].input_audio.format, "mp3");
    assert.equal(content[0].input_audio.data, "def456");
  });

  it("converts user video message to video_url", async () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [
            { type: "video", mime_type: "video/mp4", data: "fakevideo", encoding: "base64" },
          ],
        },
        sender_id: "user-1",
      },
    ];
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, "video_url");
    assert.equal(content[0].video_url.url, "data:video/mp4;base64,fakevideo");
  });

  it("includes image blocks from tool messages", async () => {
    // newest-first order (as from DB)
    const messages = [
      {
        message_data: {
          role: "tool",
          tool_id: "c1",
          content: [
            { type: "text", text: "Generated 1 image." },
            { type: "image", encoding: "base64", mime_type: "image/png", data: "iVBOR" },
          ],
        },
        sender_id: "bot",
      },
      {
        message_data: {
          role: "assistant",
          content: [{ type: "tool", tool_id: "c1", name: "generate_image", arguments: '{"prompt":"a cat"}' }],
        },
        sender_id: "bot",
      },
      {
        message_data: {
          role: "user",
          content: [{ type: "text", text: "generate an image" }],
        },
        sender_id: "user-1",
      },
    ];
    const result = await formatMessagesForOpenAI(messages);

    // Find the tool result messages
    const toolResults = result.filter((m) => m.role === "tool");
    assert.ok(toolResults.length >= 1, "Should have at least 1 tool result");

    // One should carry the image
    const imageResult = toolResults.find((m) => {
      const content = /** @type {any[]} */ (m.content);
      return Array.isArray(content) && content.some((c) => c.type === "image_url");
    });
    assert.ok(imageResult, "Tool result should include an image_url block");
    const imageBlock = /** @type {any[]} */ (imageResult.content).find((c) => c.type === "image_url");
    assert.equal(imageBlock.image_url.url, "data:image/png;base64,iVBOR");
  });

  it("strips leading tool results from message list", async () => {
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
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
  });

  it("strips mid-array orphaned tool result", async () => {
    const messages = /** @type {any} */ ([
      // newest first
      { message_data: { role: "user", content: [{ type: "text", text: "hello" }] }, sender_id: "user-1" },
      { message_data: { role: "tool", tool_id: "orphan_id", content: [{ type: "text", text: "res" }] }, sender_id: "bot" },
      { message_data: { role: "user", content: [{ type: "text", text: "hi" }] }, sender_id: "user-1" },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 2);
    assert.ok(result.every(m => m.role === "user"));
  });

  it("strips multiple orphans from one missing assistant", async () => {
    const messages = /** @type {any} */ ([
      // newest first
      { message_data: { role: "user", content: [{ type: "text", text: "hello" }] }, sender_id: "user-1" },
      { message_data: { role: "tool", tool_id: "id_B", content: [{ type: "text", text: "res2" }] }, sender_id: "bot" },
      { message_data: { role: "tool", tool_id: "id_A", content: [{ type: "text", text: "res1" }] }, sender_id: "bot" },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
  });

  it("preserves valid tool results while stripping orphans", async () => {
    const messages = /** @type {any} */ ([
      // newest first
      { message_data: { role: "user", content: [{ type: "text", text: "thanks" }] }, sender_id: "user-1" },
      { message_data: { role: "tool", tool_id: "valid_id", content: [{ type: "text", text: "result" }] }, sender_id: "bot" },
      {
        message_data: {
          role: "assistant",
          content: [{ type: "tool", tool_id: "valid_id", name: "test_fn", arguments: "{}" }],
        },
        sender_id: "bot",
      },
      { message_data: { role: "tool", tool_id: "orphan_id", content: [{ type: "text", text: "stale" }] }, sender_id: "bot" },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 3);
    assert.ok(!result.some(m => m.role === "tool" && /** @type {any} */ (m).tool_call_id === "orphan_id"));
  });

  it("preserves all messages when fully paired", async () => {
    const messages = /** @type {any} */ ([
      // newest first
      { message_data: { role: "tool", tool_id: "call_A", content: [{ type: "text", text: "done" }] }, sender_id: "bot" },
      {
        message_data: {
          role: "assistant",
          content: [{ type: "tool", tool_id: "call_A", name: "fn", arguments: "{}" }],
        },
        sender_id: "bot",
      },
      { message_data: { role: "user", content: [{ type: "text", text: "go" }] }, sender_id: "user-1" },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 3);
  });

  it("strips only orphaned tool result when mixed with valid ones", async () => {
    const messages = /** @type {any} */ ([
      // newest first
      { message_data: { role: "tool", tool_id: "orphan_id", content: [{ type: "text", text: "stale" }] }, sender_id: "bot" },
      { message_data: { role: "tool", tool_id: "valid_id", content: [{ type: "text", text: "ok" }] }, sender_id: "bot" },
      {
        message_data: {
          role: "assistant",
          content: [{ type: "tool", tool_id: "valid_id", name: "fn", arguments: "{}" }],
        },
        sender_id: "bot",
      },
      { message_data: { role: "user", content: [{ type: "text", text: "go" }] }, sender_id: "user-1" },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 3);
    assert.ok(result.some(m => m.role === "user"));
    assert.ok(result.some(m => m.role === "assistant"));
    assert.ok(result.some(m => m.role === "tool" && /** @type {any} */ (m).tool_call_id === "valid_id"));
    assert.ok(!result.some(m => m.role === "tool" && /** @type {any} */ (m).tool_call_id === "orphan_id"));
  });
});
