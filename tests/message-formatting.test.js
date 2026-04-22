import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  actionsToToolDefinitions,
  shouldRespond,
  parseCommandArgs,
  prepareMessages,
  parseStructuredQuestion,
} from "../message-formatting.js";
import sendPathAction from "../actions/tools/sendPath/index.js";

// ── actionsToToolDefinitions ──

describe("actionsToToolDefinitions", () => {
  it("maps name, description, parameters correctly", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "test_action",
        description: "A test action",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    ]);
    const result = actionsToToolDefinitions(actions);

    assert.equal(result.length, 1);
    assert.equal(result[0].type, "function");
    assert.equal(result[0].function.name, "test_action");
    assert.equal(result[0].function.description, "A test action");
    assert.deepEqual(result[0].function.parameters, actions[0].parameters);
  });

  it("converts type:'image' params to type:'string' with media hint when hasMedia is true", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "zoom_image",
        description: "Zoom into an image",
        parameters: { type: "object", properties: { image: { type: "image", description: "The image" }, x: { type: "number" } } },
      },
    ]);
    const result = actionsToToolDefinitions(actions, true);

    const params = result[0].function.parameters;
    assert.equal(params.properties.image.type, "string", "image type should be converted to string");
    assert.ok(params.properties.image.description.includes("file path"), "description should mention media file paths");
    assert.equal(params.properties.x.type, "number", "non-image params should be unchanged");
  });

  it("converts type:'image' to type:'string' even without media", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "zoom_image",
        description: "Zoom",
        parameters: { type: "object", properties: { image: { type: "image" } } },
      },
    ]);
    const result = actionsToToolDefinitions(actions, false);

    assert.equal(result[0].function.parameters.properties.image.type, "string");
    assert.ok(!result[0].function.parameters.properties.image.description.includes("[media:N]"));
  });

  it("converts array of image params", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "extract",
        description: "Extract",
        parameters: { type: "object", properties: { images: { type: "array", items: { type: "image" }, description: "Input images" } } },
      },
    ]);
    const result = actionsToToolDefinitions(actions, true);

    const prop = result[0].function.parameters.properties.images;
    assert.equal(prop.type, "array");
    assert.equal(prop.items.type, "string");
    assert.ok(prop.description.includes("file path"));
  });

  it("does not mutate original action parameters when converting image params", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "test",
        description: "Test",
        parameters: { type: "object", properties: { image: { type: "image" } } },
      },
    ]);
    actionsToToolDefinitions(actions, true);

    assert.equal(actions[0].parameters.properties.image.type, "image", "Original action should not be mutated");
  });

  it("does not modify tools that have no image params", () => {
    const actions = /** @type {Action[]} */ ([
      {
        name: "test",
        description: "Test",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    ]);
    const result = actionsToToolDefinitions(actions, true);

    // Should use the original parameters object (no copy needed)
    assert.deepEqual(result[0].function.parameters, actions[0].parameters);
  });

  it("does not leak transport-specific WhatsApp wording in send_path tool metadata", () => {
    const result = actionsToToolDefinitions([sendPathAction]);

    assert.equal(result[0].function.name, "send_path");
    assert.ok(!result[0].function.description.includes("WhatsApp"));
    assert.ok(!sendPathAction.instructions?.includes("WhatsApp"));
  });

});

// ── shouldRespond ──

describe("shouldRespond", () => {
  it("returns false for disabled or missing chat", () => {
    assert.equal(shouldRespond({ is_enabled: false }, { isGroup: false, addressedToBot: false, repliedToBot: false }), false);
    assert.equal(shouldRespond(undefined, { isGroup: false, addressedToBot: false, repliedToBot: false }), false);
  });

  it("returns true for enabled private chat", () => {
    assert.equal(
      shouldRespond({ is_enabled: true }, { isGroup: false, addressedToBot: false, repliedToBot: false }),
      true,
    );
  });

  it("respond_on=any: responds to every group message", () => {
    assert.equal(
      shouldRespond({ is_enabled: true, respond_on: "any" }, { isGroup: true, addressedToBot: false, repliedToBot: false }),
      true,
    );
  });

  it("respond_on=mention: responds only when bot is @-mentioned", () => {
    const chat = { is_enabled: true, respond_on: "mention" };
    // Mentioned → true
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: true, repliedToBot: false }), true);
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: true, repliedToBot: false }), true);
    // Not mentioned → false
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: false, repliedToBot: false }), false);
    // Reply to bot but no mention → false (mention-only mode)
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: false, repliedToBot: true, quotedSenderId: "bot-123" }), false);
  });

  it("respond_on=mention+reply: responds to mentions and replies to bot", () => {
    const chat = { is_enabled: true, respond_on: "mention+reply" };
    // Mentioned → true
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: true, repliedToBot: false }), true);
    // Reply to bot → true
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: false, repliedToBot: true, quotedSenderId: "bot-123" }), true);
    // Reply to someone else → false
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: false, repliedToBot: false, quotedSenderId: "other-user" }), false);
    // No mention, no reply → false
    assert.equal(shouldRespond(chat, { isGroup: true, addressedToBot: false, repliedToBot: false }), false);
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

// ── prepareMessages ──

describe("prepareMessages", () => {
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
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
    assert.deepEqual(result[0].content, [{ type: "text", text: "hello" }]);
  });

  it("registers user image in media registry by canonical path", () => {
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
    const { messages: result, mediaRegistry } = prepareMessages(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
    // Message content should be unchanged (internal format)
    assert.equal(result[0].content[0].type, "image");
    // Registry should map the canonical media path to the original image block
    assert.equal(mediaRegistry.size, 1);
    const [[mediaPath, mediaBlock]] = [...mediaRegistry.entries()];
    assert.match(mediaPath, /^[a-f0-9]{64}\.png$/);
    assert.equal(mediaBlock.type, "image");
    assert.equal(mediaBlock.path, mediaPath);
  });

  it("preserves user quote message", () => {
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
    const { messages: result } = prepareMessages(messages);

    assert.equal(result[0].role, "user");
    assert.equal(result[0].content[0].type, "quote");
  });

  it("preserves assistant message with tool calls (stubs expected in DB)", () => {
    // With stub-based approach, an assistant with tool_calls but no tool result
    // in the window means the tool result was outside the window — the assistant
    // is kept, but no placeholder is generated (stubs handle this at write time).
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
    const { messages: result } = prepareMessages(messages);

    // Only the assistant — no placeholder; stubs ensure tool results exist in DB
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "assistant");
    const msg = /** @type {AssistantMessage} */ (result[0]);
    const toolBlocks = msg.content.filter(b => b.type === "tool");
    assert.equal(toolBlocks.length, 1);
    assert.equal(/** @type {ToolCallContentBlock} */ (toolBlocks[0]).name, "run_javascript");
  });

  it("preserves tool result message (after an assistant with tool_calls)", () => {
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
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 2);
    const toolMsg = result.find(m => m.role === "tool");
    assert.ok(toolMsg);
    assert.equal(/** @type {ToolMessage} */ (toolMsg).tool_id, "call_123");
    assert.equal(/** @type {TextContentBlock} */ (/** @type {ToolMessage} */ (toolMsg).content[0]).text, "result");
  });

  it("does not mutate the input array", () => {
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
    prepareMessages(messages);

    assert.strictEqual(messages[0], originalFirst, "input array should not be reversed");
    assert.equal(messages.length, 2, "input array length should not change");
  });

  it("does not tag text-only messages in media registry", () => {
    const messages = [
      {
        message_data: { role: "user", content: [{ type: "text", text: "hello" }] },
        sender_id: "user-1",
      },
    ];
    const { mediaRegistry } = prepareMessages(messages);
    assert.equal(mediaRegistry.size, 0);
  });

  it("registers audio in media registry", () => {
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
    const { messages: result, mediaRegistry } = prepareMessages(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].content[0].type, "audio");
    // Audio should be registered
    assert.equal(mediaRegistry.size, 1);
    assert.equal([...mediaRegistry.values()][0].type, "audio");
  });

  it("registers video in media registry", () => {
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
    const { messages: result, mediaRegistry } = prepareMessages(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].content[0].type, "video");
    assert.equal(mediaRegistry.size, 1);
    assert.equal([...mediaRegistry.values()][0].type, "video");
  });

  it("registers image blocks from tool messages in media registry", () => {
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
    const { mediaRegistry } = prepareMessages(messages);

    // Tool image should be tagged in the registry
    assert.equal(mediaRegistry.size, 1);
    const registeredBlock = [...mediaRegistry.values()][0];
    assert.equal(registeredBlock.type, "image");
    assert.match(registeredBlock.path, /^[a-f0-9]{64}\.png$/);
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
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
  });

  it("strips mid-array orphaned tool result", () => {
    const messages = /** @type {any} */ ([
      // newest first
      { message_data: { role: "user", content: [{ type: "text", text: "hello" }] }, sender_id: "user-1" },
      { message_data: { role: "tool", tool_id: "orphan_id", content: [{ type: "text", text: "res" }] }, sender_id: "bot" },
      { message_data: { role: "user", content: [{ type: "text", text: "hi" }] }, sender_id: "user-1" },
    ]);
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 2);
    assert.ok(result.every(m => m.role === "user"));
  });

  it("strips multiple orphans from one missing assistant", () => {
    const messages = /** @type {any} */ ([
      // newest first
      { message_data: { role: "user", content: [{ type: "text", text: "hello" }] }, sender_id: "user-1" },
      { message_data: { role: "tool", tool_id: "id_B", content: [{ type: "text", text: "res2" }] }, sender_id: "bot" },
      { message_data: { role: "tool", tool_id: "id_A", content: [{ type: "text", text: "res1" }] }, sender_id: "bot" },
    ]);
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
  });

  it("preserves valid tool results while stripping orphans", () => {
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
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 3);
    assert.ok(!result.some(m => m.role === "tool" && /** @type {ToolMessage} */ (m).tool_id === "orphan_id"));
  });

  it("preserves all messages when fully paired", () => {
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
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 3);
  });

  // Tests removed: "reorders interleaved user message", "adds placeholder for
  // missing tool result", "handles multiple tool rounds with interleaving" —
  // these scenarios are now solved at the source by stub-based tool results.

  it("strips only orphaned tool result when mixed with valid ones", () => {
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
    const { messages: result } = prepareMessages(messages);

    assert.equal(result.length, 3);
    assert.ok(result.some(m => m.role === "user"));
    assert.ok(result.some(m => m.role === "assistant"));
    assert.ok(result.some(m => m.role === "tool" && /** @type {ToolMessage} */ (m).tool_id === "valid_id"));
    assert.ok(!result.some(m => m.role === "tool" && /** @type {ToolMessage} */ (m).tool_id === "orphan_id"));
  });

  it("increments media IDs across multiple messages", () => {
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
    const { mediaRegistry } = prepareMessages(messages);

    // First message (after reverse) has image + video → IDs 1, 2
    // Second message has image → ID 3
    assert.equal(mediaRegistry.size, 3);
    const blocks = [...mediaRegistry.values()];
    assert.equal(blocks[0].path.endsWith(".png"), true);
    assert.equal(blocks[1].path.endsWith(".mp4"), true);
    assert.equal(blocks[2].path.endsWith(".jpg"), true);
  });

  it("tags quoted images in media registry", () => {
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
    const { mediaRegistry } = prepareMessages(messages);

    assert.equal(mediaRegistry.size, 1);
    assert.match([...mediaRegistry.values()][0].path, /^[a-f0-9]{64}\.png$/);
  });
});

// ── parseStructuredQuestion ──

describe("parseStructuredQuestion", () => {
  it("returns null for plain text without questions", () => {
    assert.equal(parseStructuredQuestion("Hello, how are you doing today."), null);
  });

  it("detects numbered list options", () => {
    const text = "Which do you prefer:\n1. Option A\n2. Option B\n3. Option C";
    const result = parseStructuredQuestion(text);
    assert.ok(result);
    assert.deepEqual(result.options, ["Option A", "Option B", "Option C"]);
    assert.equal(result.question, "Which do you prefer:");
  });

  it("detects bulleted list options", () => {
    const text = "Here are the choices:\n- Alpha\n- Beta\n- Gamma";
    const result = parseStructuredQuestion(text);
    assert.ok(result);
    assert.deepEqual(result.options, ["Alpha", "Beta", "Gamma"]);
  });

  it("detects inline or-options in a question", () => {
    const text = "Would you prefer dark mode or light mode?";
    const result = parseStructuredQuestion(text);
    assert.ok(result);
    assert.equal(result.options.length, 2);
    assert.ok(result.options.some(o => o.includes("dark")));
    assert.ok(result.options.some(o => o.includes("light")));
  });

  it("detects yes/no confirmation questions", () => {
    const text = "I've made the changes. Would you like me to commit them?";
    const result = parseStructuredQuestion(text);
    assert.ok(result);
    assert.deepEqual(result.options, ["Yes", "No"]);
    assert.ok(result.question.includes("Would you like"));
  });

  it("extracts preamble before list without duplicating the question line", () => {
    const text = "I found several issues.\n\nWhich should I fix?\n1. Bug A\n2. Bug B";
    const result = parseStructuredQuestion(text);
    assert.ok(result);
    assert.equal(result.preamble, "I found several issues.");
    assert.equal(result.question, "Which should I fix?");
    assert.deepEqual(result.options, ["Bug A", "Bug B"]);
  });

  it("returns null for a single-item list", () => {
    const text = "Here is the result:\n1. Only one thing";
    assert.equal(parseStructuredQuestion(text), null);
  });

  it("returns null for lists with more than 10 items", () => {
    const items = Array.from({ length: 11 }, (_, i) => `${i + 1}. Item ${i + 1}`).join("\n");
    const text = `Pick one:\n${items}`;
    assert.equal(parseStructuredQuestion(text), null);
  });

  it("detects 'Should I proceed?' as yes/no", () => {
    const text = "All tests pass. Should I proceed?";
    const result = parseStructuredQuestion(text);
    assert.ok(result);
    assert.deepEqual(result.options, ["Yes", "No"]);
  });

  it("returns null for rhetorical questions without patterns", () => {
    const text = "What a great day, isn't it?";
    assert.equal(parseStructuredQuestion(text), null);
  });
});
