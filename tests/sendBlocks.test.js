import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {typeof import("../whatsapp-adapter.js").sendBlocks} */
let sendBlocks;

before(async () => {
  const testDb = await createTestDb();
  setDb("./pgdata/root", testDb);
  const adapter = await import("../whatsapp-adapter.js");
  sendBlocks = adapter.sendBlocks;
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

  it("handles type 'text' without image rendering", async () => {
    const { sock, sent } = createMockSock();

    const textWithCode = "Here is ```console.log('hi')``` inline.";

    await sendBlocks(sock, "test-chat", "llm", [{ type: "text", text: textWithCode }]);

    const imageMessages = sent.filter(s => s.msg.image != null);
    assert.equal(imageMessages.length, 0, "Text blocks should NOT render images");
    assert.equal(sent.length, 1, "Should send one text message");
  });
});
