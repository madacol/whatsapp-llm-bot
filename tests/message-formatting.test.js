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

  it("injects _media_refs when hasMedia is true", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "edit_image",
        description: "Edit an image",
        parameters: { type: "object", properties: { prompt: { type: "string" } } },
      },
    ]);
    const result = actionsToOpenAIFormat(actions, true);

    const params = result[0].function.parameters;
    assert.ok(params.properties._media_refs, "Should have _media_refs property");
    assert.equal(params.properties._media_refs.type, "array");
    assert.equal(params.properties._media_refs.items.type, "integer");
    // Original prompt property should still be there
    assert.ok(params.properties.prompt, "Original properties should be preserved");
  });

  it("does not inject _media_refs when hasMedia is false", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "test",
        description: "Test",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    ]);
    const result = actionsToOpenAIFormat(actions, false);

    assert.ok(!result[0].function.parameters.properties._media_refs);
  });

  it("does not mutate original action parameters when injecting _media_refs", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "test",
        description: "Test",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    ]);
    actionsToOpenAIFormat(actions, true);

    assert.ok(!actions[0].parameters.properties._media_refs, "Original action should not be mutated");
  });

});

// ── shouldRespond ──

describe("shouldRespond", () => {
  it("returns false for disabled or missing chat", () => {
    assert.equal(shouldRespond({ is_enabled: false }, false, [], [], undefined), false);
    assert.equal(shouldRespond(undefined, false, [], [], undefined), false);
  });

  it("returns true for enabled private chat", () => {
    assert.equal(
      shouldRespond({ is_enabled: true }, false, [{ type: "text", text: "hi" }], ["bot"], undefined),
      true,
    );
  });

  it("respond_on=any: responds to every group message", () => {
    assert.equal(
      shouldRespond({ is_enabled: true, respond_on: "any" }, true, [{ type: "text", text: "hello everyone" }], ["bot-123"], undefined),
      true,
    );
  });

  it("respond_on=mention: responds only when bot is @-mentioned", () => {
    const chat = { is_enabled: true, respond_on: "mention" };
    const selfIds = ["bot-123", "alt-id"];
    // Mentioned → true
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "@bot-123 hello" }], selfIds, undefined), true);
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "hey @alt-id" }], selfIds, undefined), true);
    // Not mentioned → false
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "hello everyone" }], selfIds, undefined), false);
    // Reply to bot but no mention → false (mention-only mode)
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "hello" }], selfIds, "bot-123"), false);
  });

  it("respond_on=mention+reply: responds to mentions and replies to bot", () => {
    const chat = { is_enabled: true, respond_on: "mention+reply" };
    const selfIds = ["bot-123"];
    // Mentioned → true
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "@bot-123 hello" }], selfIds, undefined), true);
    // Reply to bot → true
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "hello" }], selfIds, "bot-123"), true);
    // Reply to someone else → false
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "hello" }], selfIds, "other-user"), false);
    // No mention, no reply → false
    assert.equal(shouldRespond(chat, true, [{ type: "text", text: "hello" }], selfIds, undefined), false);
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
    const { messages: result } = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
    assert.deepEqual(result[0].content, [{ type: "text", text: "hello" }]);
  });

  it("converts user image message to image_url with media tag", async () => {
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
    const { messages: result, mediaRegistry } = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].type, "image_url");
    assert.equal(content[0].image_url.url, "data:image/png;base64,abc123");
    // Should have a [media:1] tag after the image
    assert.equal(content[1].type, "text");
    assert.equal(content[1].text, "[media:1]");
    // Registry should map ID 1 to the original image block
    assert.equal(mediaRegistry.size, 1);
    assert.equal(mediaRegistry.get(1).type, "image");
    assert.equal(mediaRegistry.get(1).data, "abc123");
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
    const { messages: result } = await formatMessagesForOpenAI(messages);

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
    const { messages: result } = await formatMessagesForOpenAI(messages);

    // Assistant + placeholder for missing tool result
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "assistant");
    const msg = /** @type {import("openai").default.ChatCompletionAssistantMessageParam} */ (result[0]);
    assert.ok(msg.tool_calls);
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, "run_javascript");
    // Placeholder for missing result
    assert.equal(result[1].role, "tool");
    assert.equal(/** @type {any} */ (result[1]).tool_call_id, "call_123");
    assert.equal(/** @type {any} */ (result[1]).content, "[tool result unavailable]");
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
    const { messages: result } = await formatMessagesForOpenAI(messages);

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

  it("does not tag text-only messages in media registry", async () => {
    const messages = [
      {
        message_data: { role: "user", content: [{ type: "text", text: "hello" }] },
        sender_id: "user-1",
      },
    ];
    const { mediaRegistry } = await formatMessagesForOpenAI(messages);
    assert.equal(mediaRegistry.size, 0);
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
    const { messages: result, mediaRegistry } = await formatMessagesForOpenAI(messages);
    assert.equal(result.length, 1);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].type, "input_audio");
    assert.equal(content[0].input_audio.format, "wav");
    assert.equal(content[0].input_audio.data, "abc123");
    // Audio should be tagged
    assert.equal(content[1].type, "text");
    assert.equal(content[1].text, "[media:1]");
    assert.equal(mediaRegistry.size, 1);
    assert.equal(mediaRegistry.get(1).type, "audio");
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
    const { messages: result } = await formatMessagesForOpenAI(messages);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content[0].input_audio.format, "mp3");
    assert.equal(content[0].input_audio.data, "def456");
  });

  it("converts user video message to video_url with media tag", async () => {
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
    const { messages: result, mediaRegistry } = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 1);
    const content = /** @type {any[]} */ (result[0].content);
    assert.equal(content.length, 2); // video_url + media tag
    assert.equal(content[0].type, "video_url");
    assert.equal(content[0].video_url.url, "data:video/mp4;base64,fakevideo");
    assert.equal(content[1].type, "text");
    assert.equal(content[1].text, "[media:1]");
    assert.equal(mediaRegistry.size, 1);
    assert.equal(mediaRegistry.get(1).type, "video");
  });

  it("includes image blocks from tool messages with media tags", async () => {
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
    const { messages: result, mediaRegistry } = await formatMessagesForOpenAI(messages);

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

    // Tool image should be tagged in the registry
    assert.equal(mediaRegistry.size, 1);
    const registeredBlock = mediaRegistry.get(1);
    assert.equal(registeredBlock.type, "image");
    assert.equal(registeredBlock.data, "iVBOR");
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
    const { messages: result } = await formatMessagesForOpenAI(messages);

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
    const { messages: result } = await formatMessagesForOpenAI(messages);

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
    const { messages: result } = await formatMessagesForOpenAI(messages);

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
    const { messages: result } = await formatMessagesForOpenAI(messages);

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
    const { messages: result } = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 3);
  });

  it("reorders interleaved user message to after tool results", async () => {
    // Scenario: user sends a message while the bot is executing a tool call
    // DB order (newest first): tool(A), user, assistant(tool_calls:[A])
    // After reverse: assistant(tool_calls:[A]), user, tool(A)
    // Expected: assistant(tool_calls:[A]), tool(A), user
    const messages = /** @type {any} */ ([
      { message_data: { role: "tool", tool_id: "call_A", content: [{ type: "text", text: "done" }] }, sender_id: "bot" },
      { message_data: { role: "user", content: [{ type: "text", text: "wait nvm" }] }, sender_id: "user-1" },
      { message_data: { role: "assistant", content: [{ type: "tool", tool_id: "call_A", name: "fn", arguments: "{}" }] }, sender_id: "bot" },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 3);
    assert.equal(result[0].role, "assistant");
    assert.equal(result[1].role, "tool");
    assert.equal(/** @type {any} */ (result[1]).tool_call_id, "call_A");
    assert.equal(result[2].role, "user");
  });

  it("adds placeholder for missing tool result", async () => {
    // Scenario: bot crashed mid-execution, only one of two tool results recorded
    // DB order (newest first): tool(A), assistant(tool_calls:[A,B])
    // After reverse: assistant(tool_calls:[A,B]), tool(A)
    // Expected: assistant(tool_calls:[A,B]), tool(A), tool(B, placeholder)
    const messages = /** @type {any} */ ([
      { message_data: { role: "tool", tool_id: "call_A", content: [{ type: "text", text: "result A" }] }, sender_id: "bot" },
      {
        message_data: {
          role: "assistant",
          content: [
            { type: "tool", tool_id: "call_A", name: "fn_a", arguments: "{}" },
            { type: "tool", tool_id: "call_B", name: "fn_b", arguments: "{}" },
          ],
        },
        sender_id: "bot",
      },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 3);
    assert.equal(result[0].role, "assistant");
    assert.equal(result[1].role, "tool");
    assert.equal(/** @type {any} */ (result[1]).tool_call_id, "call_A");
    assert.equal(result[2].role, "tool");
    assert.equal(/** @type {any} */ (result[2]).tool_call_id, "call_B");
    assert.equal(/** @type {any} */ (result[2]).content, "[tool result unavailable]");
  });

  it("handles multiple tool rounds with interleaving", async () => {
    // Two assistant→tool rounds, user message intrudes in the second
    // DB order (newest first): tool(C), user_interloper, assistant(tool_calls:[C]), tool(A), assistant(tool_calls:[A]), user_original
    // After reverse: user_original, assistant(tool_calls:[A]), tool(A), assistant(tool_calls:[C]), user_interloper, tool(C)
    // Expected: user_original, assistant(tool_calls:[A]), tool(A), assistant(tool_calls:[C]), tool(C), user_interloper
    const messages = /** @type {any} */ ([
      { message_data: { role: "tool", tool_id: "call_C", content: [{ type: "text", text: "done C" }] }, sender_id: "bot" },
      { message_data: { role: "user", content: [{ type: "text", text: "interloper" }] }, sender_id: "user-1" },
      {
        message_data: {
          role: "assistant",
          content: [{ type: "tool", tool_id: "call_C", name: "fn_c", arguments: "{}" }],
        },
        sender_id: "bot",
      },
      { message_data: { role: "tool", tool_id: "call_A", content: [{ type: "text", text: "done A" }] }, sender_id: "bot" },
      {
        message_data: {
          role: "assistant",
          content: [{ type: "tool", tool_id: "call_A", name: "fn_a", arguments: "{}" }],
        },
        sender_id: "bot",
      },
      { message_data: { role: "user", content: [{ type: "text", text: "original" }] }, sender_id: "user-1" },
    ]);
    const result = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 6);
    assert.equal(result[0].role, "user"); // original
    assert.equal(result[1].role, "assistant"); // tool_calls:[A]
    assert.equal(result[2].role, "tool"); // tool(A)
    assert.equal(/** @type {any} */ (result[2]).tool_call_id, "call_A");
    assert.equal(result[3].role, "assistant"); // tool_calls:[C]
    assert.equal(result[4].role, "tool"); // tool(C)
    assert.equal(/** @type {any} */ (result[4]).tool_call_id, "call_C");
    assert.equal(result[5].role, "user"); // interloper
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
    const { messages: result } = await formatMessagesForOpenAI(messages);

    assert.equal(result.length, 3);
    assert.ok(result.some(m => m.role === "user"));
    assert.ok(result.some(m => m.role === "assistant"));
    assert.ok(result.some(m => m.role === "tool" && /** @type {any} */ (m).tool_call_id === "valid_id"));
    assert.ok(!result.some(m => m.role === "tool" && /** @type {any} */ (m).tool_call_id === "orphan_id"));
  });

  it("increments media IDs across multiple messages", async () => {
    const messages = /** @type {any} */ ([
      // newest first → reversed to chronological
      {
        message_data: {
          role: "user",
          content: [
            { type: "image", mime_type: "image/jpeg", data: "img2", encoding: "base64" },
          ],
        },
        sender_id: "user-1",
      },
      {
        message_data: {
          role: "user",
          content: [
            { type: "image", mime_type: "image/png", data: "img1", encoding: "base64" },
            { type: "video", mime_type: "video/mp4", data: "vid1", encoding: "base64" },
          ],
        },
        sender_id: "user-1",
      },
    ]);
    const { mediaRegistry } = await formatMessagesForOpenAI(messages);

    // First message (after reverse) has image + video → IDs 1, 2
    // Second message has image → ID 3
    assert.equal(mediaRegistry.size, 3);
    assert.equal(mediaRegistry.get(1).data, "img1");
    assert.equal(mediaRegistry.get(2).data, "vid1");
    assert.equal(mediaRegistry.get(3).data, "img2");
  });

  it("tags quoted images in media registry", async () => {
    const messages = [
      {
        message_data: {
          role: "user",
          content: [
            {
              type: "quote",
              content: [
                { type: "image", mime_type: "image/png", data: "quotedImg", encoding: "base64" },
              ],
            },
          ],
        },
        sender_id: "user-1",
      },
    ];
    const { messages: result, mediaRegistry } = await formatMessagesForOpenAI(messages);

    assert.equal(mediaRegistry.size, 1);
    assert.equal(mediaRegistry.get(1).data, "quotedImg");
    const content = /** @type {any[]} */ (result[0].content);
    // Should have image_url followed by [media:1] tag
    assert.equal(content[0].type, "image_url");
    assert.equal(content[1].type, "text");
    assert.equal(content[1].text, "[media:1]");
  });
});
