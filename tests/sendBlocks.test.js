import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {typeof import("../whatsapp/outbound/send-content.js").sendBlocks} */
let sendBlocks;
/** @type {typeof import("../whatsapp/outbound/send-content.js").editWhatsAppMessage} */
let editWhatsAppMessage;

before(async () => {
  const testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  const outbound = await import("../whatsapp/outbound/send-content.js");
  sendBlocks = outbound.sendBlocks;
  editWhatsAppMessage = outbound.editWhatsAppMessage;
});

/**
 * Create a mock socket that captures sent messages.
 * @returns {{ sock: any, sent: Array<{ chatId: string; msg: Record<string, unknown> }> }}
 */
function createMockSock() {
  /** @type {Array<{ chatId: string; msg: Record<string, unknown> }>} */
  const sent = [];
  const sock = {
    sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg) => {
      sent.push({ chatId, msg });
      return { key: { id: `msg-${sent.length}`, remoteJid: chatId } };
    },
  };
  return { sock, sent };
}

describe("sendBlocks – markdown with code", () => {
  it("renders code blocks inside markdown as images", async () => {
    const { sock, sent } = createMockSock();

    const markdown = `Here is some code:

\`\`\`javascript
function greet(name) {
  const msg = "Hello, " + name;
  console.log(msg);
  return msg;
}
greet("world");
\`\`\`

And some text after.`;

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    // Should have sent at least 3 messages: text before, image, text after
    const textMessages = sent.filter(s => typeof s.msg.text === "string");
    const imageMessages = sent.filter(s => s.msg.image != null);

    assert.ok(
      imageMessages.length >= 1,
      `Expected at least 1 image message for code block, got ${imageMessages.length}. ` +
      `All messages: ${JSON.stringify(sent.map(s => Object.keys(s.msg)), null, 2)}`,
    );

    // The image should be a Buffer (PNG)
    const firstImage = imageMessages[0];
    assert.ok(
      Buffer.isBuffer(firstImage.msg.image),
      "Code block image should be a Buffer",
    );

    // Text parts should still be present
    assert.ok(
      textMessages.some(m => /** @type {string} */ (m.msg.text).includes("some code")),
      "Should have text before code block",
    );
    assert.ok(
      textMessages.some(m => /** @type {string} */ (m.msg.text).includes("text after")),
      "Should have text after code block",
    );
  });

  it("long code that splits into multiple images sends them in a single message", async () => {
    const { sock, sent } = createMockSock();

    // 100 lines of narrow code — fits in a single image after adaptive splitting
    const longCode = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join("\n");

    await sendBlocks(sock, "test-chat", "llm", [
      { type: "code", language: "javascript", code: longCode },
    ]);

    // The split images should be bundled into a single message, not sent as
    // separate sock.sendMessage calls — otherwise the user gets spammed with
    // individual image messages for what is conceptually one code block.
    const imageMessages = sent.filter(s => s.msg.image != null);
    assert.equal(
      imageMessages.length, 1,
      `Split images from a single code block should be sent as one message, got ${imageMessages.length}`,
    );
  });

  it("renders multiple code blocks as separate images", async () => {
    const { sock, sent } = createMockSock();

    const markdown = `First block:

\`\`\`python
def greet(name):
    msg = f"Hello, {name}!"
    print(msg)
    return msg

greet("world")
\`\`\`

Second block:

\`\`\`json
{
  "name": "test",
  "version": "1.0",
  "description": "example",
  "main": "index.js"
}
\`\`\``;

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    const imageMessages = sent.filter(s => s.msg.image != null);
    assert.equal(
      imageMessages.length, 2,
      `Expected 2 image messages, got ${imageMessages.length}`,
    );
  });

  it("falls back to text if code rendering fails", async () => {
    const { sock, sent } = createMockSock();

    // Empty code block — should still not crash
    const markdown = "Check this:\n\n```\n\n```\n\nDone.";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    // Should not crash, and should have sent something
    assert.ok(sent.length > 0, "Should have sent at least one message");
  });

  it("sends plain markdown without code as formatted text", async () => {
    const { sock, sent } = createMockSock();

    const markdown = "This is **bold** and *italic* text with a [link](https://example.com).";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "markdown", text: markdown }]);

    const textMessages = sent.filter(s => typeof s.msg.text === "string");
    assert.equal(textMessages.length, 1, "Should send one text message");

    // Should have WhatsApp formatting applied
    const text = /** @type {string} */ (textMessages[0].msg.text);
    assert.ok(text.includes("*bold*"), "Bold should be converted to WhatsApp format");
    assert.ok(text.includes("_italic_"), "Italic should be converted to WhatsApp format");
  });

  it("sends one-line diff as a single image message with caption", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "tool-call", [
      { type: "diff", oldStr: "const x = 1;", newStr: "const x = 2;", language: "javascript", caption: "*Edit*  `foo.js`" },
    ]);

    // Should send exactly one image message (not a separate text + image)
    assert.equal(sent.length, 1, `Expected 1 message, got ${sent.length}`);
    const msg = sent[0].msg;
    assert.ok(Buffer.isBuffer(msg.image), "Should be an image buffer");
    assert.ok(
      typeof msg.caption === "string" && msg.caption.includes("Edit"),
      "Caption should contain the header text",
    );
  });

  it("sends diff without caption when no caption is provided", async () => {
    const { sock, sent } = createMockSock();

    await sendBlocks(sock, "test-chat", "tool-call", [
      { type: "diff", oldStr: "a", newStr: "b", language: "python" },
    ]);

    assert.equal(sent.length, 1);
    const msg = sent[0].msg;
    assert.ok(Buffer.isBuffer(msg.image), "Should be an image buffer");
    assert.equal(msg.caption, undefined);
  });

  it("handles type 'text' without image rendering", async () => {
    const { sock, sent } = createMockSock();

    const textWithCode = "Here is ```console.log('hi')``` inline.";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "text", text: textWithCode }]);

    const imageMessages = sent.filter(s => s.msg.image != null);
    assert.equal(imageMessages.length, 0, "Text blocks should NOT render images");
    assert.equal(sent.length, 1, "Should send one text message");
  });
});

describe("sendBlocks – MessageHandle tracking", () => {
  it("returns handle for text blocks with correct keyId and isImage=false", async () => {
    const { sock } = createMockSock();

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "hello" },
    ]);

    assert.ok(handle, "Should return a handle");
    assert.equal(typeof handle, "object", "Handle should be an object");
    assert.equal(typeof handle.update, "function", "Handle should have update method");
    assert.equal(typeof handle.setInspect, "function", "Handle should have setInspect method");
    assert.equal(handle.keyId, "msg-1");
    assert.equal(handle.isImage, false);
  });

  it("returns handle for code image blocks with isImage=true", async () => {
    const { sock } = createMockSock();

    // 6-line JS code will trigger image rendering
    const code = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;";
    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "code", language: "javascript", code },
    ]);

    assert.ok(handle, "Should return a handle for code images");
    assert.equal(handle.isImage, true);
  });

  it("tracks the last editable message when multiple blocks are sent", async () => {
    const { sock } = createMockSock();

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);

    assert.ok(handle, "Should return a handle");
    // msg-2 because the second text message is the last editable one
    assert.equal(handle.keyId, "msg-2");
  });

  it("returns undefined when no editable messages are sent", async () => {
    const { sock } = createMockSock();

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "audio", data: Buffer.from("fake").toString("base64"), mime_type: "audio/mp4" },
    ]);

    assert.equal(handle, undefined);
  });

  it("handle.update calls editWhatsAppMessage when invoked", async () => {
    /** @type {Array<{ chatId: string; msg: Record<string, unknown>; opts?: Record<string, unknown> }>} */
    const sent = [];
    const sock = {
      sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown>} */ opts) => {
        sent.push({ chatId, msg, opts });
        return { key: { id: `msg-${sent.length}`, remoteJid: chatId } };
      },
    };

    const handle = await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "original" },
    ]);

    assert.ok(handle);
    await handle.update({ kind: "text", text: "updated" });

    // The update call should be the second sendMessage (first was the original)
    const editCall = sent[1];
    assert.ok(editCall, "Handle.update should have sent an edit");
    assert.ok(
      typeof editCall.msg.text === "string" && editCall.msg.text.includes("updated"),
      "Edit should contain the new text",
    );
  });
});

describe("sendBlocks – options propagation", () => {
  it("passes quoted option to all sock.sendMessage calls", async () => {
    /** @type {Array<{ chatId: string; msg: Record<string, unknown>; opts?: Record<string, unknown> }>} */
    const sent = [];
    const sock = {
      sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown> | undefined} */ opts) => {
        sent.push({ chatId, msg, opts });
        return { key: { id: `msg-${sent.length}`, remoteJid: chatId } };
      },
    };

    const quotedMsg = { key: { id: "original-msg", remoteJid: "test-chat" } };
    await sendBlocks(sock, "test-chat", "llm", [
      { type: "text", text: "reply" },
    ], { quoted: /** @type {BaileysMessage} */ (quotedMsg) });

    assert.ok(sent[0].opts?.quoted === quotedMsg, "Should pass quoted to sock.sendMessage");
  });
});

describe("sendBlocks – tool-call → edit pipeline", () => {
  /**
   * Create a mock socket that records both sendMessage and relayMessage calls.
   * @returns {{ sock: any, calls: Array<{ method: string; args: unknown[] }> }}
   */
  function createCaptureSock() {
    /** @type {Array<{ method: string; args: unknown[] }>} */
    const calls = [];
    let counter = 0;
    const sock = {
      sendMessage: async (/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown> | undefined} */ opts) => {
        calls.push({ method: "sendMessage", args: [chatId, msg, opts] });
        counter++;
        return { key: { id: `msg-${counter}`, remoteJid: chatId } };
      },
      relayMessage: async (/** @type {string} */ jid, /** @type {Record<string, unknown>} */ msg, /** @type {Record<string, unknown>} */ opts) => {
        calls.push({ method: "relayMessage", args: [jid, msg, opts] });
      },
    };
    return { sock, calls };
  }

  it("text tool-call: send → progress update → final update uses sendMessage with edit key", async () => {
    const { sock, calls } = createCaptureSock();

    // Step 1: Send initial tool-call message
    const handle = await sendBlocks(sock, "chat-1", "tool-call", [
      { type: "text", text: "Read file.js" },
    ]);

    assert.ok(handle, "Should return a handle");
    assert.equal(handle.isImage, false, "Text message handle should not be image");
    assert.equal(calls.length, 1, "Should have sent 1 message");

    // Step 2: Simulate progress update (tool still running)
    await handle.update({ kind: "text", text: "Read (3s…)" });
    assert.equal(calls.length, 2, "Should have 2 calls after progress update");

    const progressCall = calls[1];
    assert.equal(progressCall.method, "sendMessage", "Progress update should use sendMessage");
    const progressMsg = /** @type {Record<string, unknown>} */ (progressCall.args[1]);
    assert.ok(typeof progressMsg.text === "string" && progressMsg.text.includes("Read (3s…)"), "Progress text should be in edit");
    assert.ok(progressMsg.edit != null, "Should include edit key for in-place update");

    // Step 3: Simulate final result
    await handle.update({ kind: "text", text: "Read · file.js (42 lines)" });
    assert.equal(calls.length, 3, "Should have 3 calls after final update");

    const finalCall = calls[2];
    const finalMsg = /** @type {Record<string, unknown>} */ (finalCall.args[1]);
    assert.ok(typeof finalMsg.text === "string" && finalMsg.text.includes("Read · file.js"), "Final text should be in edit");
    // The edit key should reference the original message
    const editKey = /** @type {{ id: string }} */ (finalMsg.edit);
    assert.equal(editKey.id, "msg-1", "Edit key should reference the original message");
  });

  it("image tool-call: send → edit uses relayMessage for caption update", async () => {
    const { sock, calls } = createCaptureSock();

    // Send a code block that renders as an image (6+ lines triggers image rendering)
    const code = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;";
    const handle = await sendBlocks(sock, "chat-1", "tool-call", [
      { type: "code", language: "javascript", code },
    ]);

    assert.ok(handle, "Should return a handle for code image");
    assert.equal(handle.isImage, true, "Code image handle should be marked as image");

    const initialCallCount = calls.length;

    // Edit the image caption
    await handle.update({ kind: "text", text: "Edit · foo.js" });

    // Image edits use relayMessage, not sendMessage
    const editCall = calls[initialCallCount];
    assert.equal(editCall.method, "relayMessage", "Image caption edit should use relayMessage");
    const relayMsg = /** @type {Record<string, unknown>} */ (editCall.args[1]);
    const protoMsg = /** @type {Record<string, unknown>} */ (relayMsg.protocolMessage);
    assert.ok(protoMsg, "Should contain protocolMessage");
    const editedMsg = /** @type {Record<string, unknown>} */ (protoMsg.editedMessage);
    const imageMsg = /** @type {{ caption: string }} */ (editedMsg.imageMessage);
    assert.ok(imageMsg.caption.includes("Edit · foo.js"), "Caption should contain the new text");
  });

  it("handle.update prepends source prefix on every edit", async () => {
    const { sock, calls } = createCaptureSock();

    const handle = await sendBlocks(sock, "chat-1", "tool-call", [
      { type: "text", text: "running" },
    ]);

    assert.ok(handle);
    await handle.update({ kind: "text", text: "done" });

    const editMsg = /** @type {Record<string, unknown>} */ (calls[1].args[1]);
    const editText = /** @type {string} */ (editMsg.text);
    // "tool-call" prefix is "🔧"
    assert.ok(editText.startsWith("🔧"), `Edit text should start with tool-call prefix, got: ${editText}`);
    assert.ok(editText.includes("done"), "Edit text should contain new content");
  });

  it("editWhatsAppMessage directly: text path sends edit key", async () => {
    const { sock, calls } = createCaptureSock();
    const key = { id: "msg-abc", remoteJid: "chat-1" };

    await editWhatsAppMessage(sock, "chat-1", key, "updated text", false);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "sendMessage");
    const msg = /** @type {Record<string, unknown>} */ (calls[0].args[1]);
    assert.equal(msg.text, "updated text");
    assert.deepEqual(msg.edit, key);
  });

  it("editWhatsAppMessage directly: image path uses relayMessage with protocolMessage", async () => {
    const { sock, calls } = createCaptureSock();
    const key = { id: "msg-xyz", remoteJid: "chat-1" };

    await editWhatsAppMessage(sock, "chat-1", key, "new caption", true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "relayMessage");
    const relayMsg = /** @type {Record<string, unknown>} */ (calls[0].args[1]);
    const proto = /** @type {Record<string, unknown>} */ (relayMsg.protocolMessage);
    assert.ok(proto, "Should have protocolMessage");
    assert.deepEqual(proto.key, key, "Should reference the original message key");
    const edited = /** @type {Record<string, unknown>} */ (proto.editedMessage);
    const imgMsg = /** @type {{ caption: string }} */ (edited.imageMessage);
    assert.equal(imgMsg.caption, "new caption");
    // Check additionalAttributes
    const opts = /** @type {{ additionalAttributes: Record<string, string> }} */ (calls[0].args[2]);
    assert.equal(opts.additionalAttributes.edit, "1", "Should have edit='1' attribute");
  });
});
