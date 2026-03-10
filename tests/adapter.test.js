import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {typeof import("../whatsapp-adapter.js").getMessageContent} */
let getMessageContent;

/** @type {typeof import("../whatsapp-adapter.js").createConfirmRegistry} */
let createConfirmRegistry;

before(async () => {
  // Seed DB cache so initStore() in index.js uses in-memory DB
  const testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  const adapter = await import("../whatsapp-adapter.js");
  getMessageContent = adapter.getMessageContent;
  createConfirmRegistry = adapter.createConfirmRegistry;
});

/**
 * Create a mock Baileys socket and confirm registry for testing.
 * @returns {{ sock: any, registry: ReturnType<typeof createConfirmRegistry>, sentMessages: any[], reactions: any[], emitReaction: (key: any, reaction: any) => void }}
 */
function createMockSock() {
  /** @type {any[]} */
  const sentMessages = [];
  /** @type {any[]} */
  const reactions = [];

  const sock = {
    sendMessage: async (/** @type {string} */ chatId, /** @type {any} */ msg) => {
      if (msg.react) {
        reactions.push(msg.react);
        return null;
      }
      const key = { id: `msg-${sentMessages.length}`, remoteJid: chatId };
      sentMessages.push({ chatId, msg, key });
      return { key };
    },
  };

  const registry = createConfirmRegistry();

  return {
    sock,
    registry,
    sentMessages,
    reactions,
    /** Route a reaction through the registry (mirrors what registerHandlers does). */
    emitReaction: (/** @type {{ id: string; remoteJid: string }} */ key, /** @type {{ text: string }} */ reaction) => {
      registry.handleReactions([{ key, reaction }], sock);
    },
  };
}

describe("getMessageContent", () => {
  it("extracts quoted message with reply text", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "My reply",
          contextInfo: {
            quotedMessage: { conversation: "Original" },
          },
        },
      },
    });
    const { content } = await getMessageContent(msg);

    assert.ok(content.some(b => b.type === "quote"), "Should have quote block");
    assert.ok(
      content.some(b => b.type === "text" && /** @type {Partial<BaileysMessage>} */ (b).text === "My reply"),
      "Should have reply text",
    );

    const quote = /** @type {Partial<BaileysMessage>} */ (content.find(b => b.type === "quote"));
    assert.ok(
      quote.content.some(b => b.type === "text" && b.text === "Original"),
      "Quote should contain original text",
    );
  });

  it("extracts quoted extendedTextMessage", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "replying",
          contextInfo: {
            quotedMessage: {
              extendedTextMessage: { text: "original extended" },
            },
          },
        },
      },
    });
    const { content } = await getMessageContent(msg);

    const quote = /** @type {Partial<BaileysMessage>} */ (content.find(b => b.type === "quote"));
    assert.ok(quote, "Should have quote block");
    assert.ok(
      quote.content.some(b => b.type === "text" && b.text === "original extended"),
    );
  });

  it("extracts image caption from quoted message", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "About this image",
          contextInfo: {
            quotedMessage: {
              imageMessage: { caption: "Image caption" },
            },
          },
        },
      },
    });
    const { content } = await getMessageContent(msg);

    const quote = /** @type {Partial<BaileysMessage>} */ (content.find(b => b.type === "quote"));
    assert.ok(quote);
    assert.ok(
      quote.content.some(b => b.type === "text" && b.text === "Image caption"),
    );
  });

  it("extracts document caption as text", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: { documentMessage: { caption: "See attached" } },
    });
    const { content } = await getMessageContent(msg);

    assert.ok(
      content.some(b => b.type === "text" && /** @type {Partial<BaileysMessage>} */ (b).text === "See attached"),
    );
  });

  it("extracts quotedSenderId from contextInfo participant", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "My reply",
          contextInfo: {
            quotedMessage: { conversation: "Original" },
            participant: "12345@s.whatsapp.net",
          },
        },
      },
    });
    const { quotedSenderId } = await getMessageContent(msg);
    assert.equal(quotedSenderId, "12345");
  });

  it("downloads quoted image into quote block", async () => {
    const fakeBuffer = Buffer.from("fake-image-data");
    const mockDownload = async () => fakeBuffer;
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "What's this?",
          contextInfo: {
            quotedMessage: {
              imageMessage: { mimetype: "image/jpeg", url: "https://example.com/img" },
            },
            participant: "555@s.whatsapp.net",
          },
        },
      },
    });
    const { content, quotedSenderId } = await getMessageContent(msg, mockDownload);

    const quote = /** @type {QuoteContentBlock} */ (content.find(b => b.type === "quote"));
    assert.ok(quote, "Should have quote block");
    assert.equal(quote.quotedSenderId, "555");
    assert.equal(quotedSenderId, "555");
    assert.ok(
      quote.content.some(b => b.type === "image"),
      "Quote content should contain image block",
    );
    const imageBlock = /** @type {ImageContentBlock} */ (quote.content.find(b => b.type === "image"));
    assert.equal(imageBlock.mime_type, "image/jpeg");
    assert.equal(imageBlock.data, fakeBuffer.toString("base64"));
  });

  it("downloads quoted video into quote block", async () => {
    const fakeBuffer = Buffer.from("fake-video-data");
    const mockDownload = async () => fakeBuffer;
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "nice video",
          contextInfo: {
            quotedMessage: {
              videoMessage: { mimetype: "video/mp4", url: "https://example.com/vid" },
            },
          },
        },
      },
    });
    const { content } = await getMessageContent(msg, mockDownload);

    const quote = /** @type {QuoteContentBlock} */ (content.find(b => b.type === "quote"));
    assert.ok(quote, "Should have quote block");
    const videoBlock = /** @type {VideoContentBlock} */ (quote.content.find(b => b.type === "video"));
    assert.ok(videoBlock, "Quote should contain video block");
    assert.equal(videoBlock.mime_type, "video/mp4");
  });

  it("downloads quoted audio into quote block", async () => {
    const fakeBuffer = Buffer.from("fake-audio-data");
    const mockDownload = async () => fakeBuffer;
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "what did you say?",
          contextInfo: {
            quotedMessage: {
              audioMessage: { mimetype: "audio/ogg", url: "https://example.com/aud" },
            },
          },
        },
      },
    });
    const { content } = await getMessageContent(msg, mockDownload);

    const quote = /** @type {QuoteContentBlock} */ (content.find(b => b.type === "quote"));
    assert.ok(quote, "Should have quote block");
    const audioBlock = /** @type {AudioContentBlock} */ (quote.content.find(b => b.type === "audio"));
    assert.ok(audioBlock, "Quote should contain audio block");
    assert.equal(audioBlock.mime_type, "audio/ogg");
  });

  it("falls back to text placeholder when quoted media download fails", async () => {
    const mockDownload = async () => { throw new Error("download failed"); };
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: {
        extendedTextMessage: {
          text: "What's this?",
          contextInfo: {
            quotedMessage: {
              imageMessage: { mimetype: "image/jpeg", url: "https://example.com/img" },
            },
          },
        },
      },
    });
    const { content } = await getMessageContent(msg, mockDownload);

    const quote = /** @type {QuoteContentBlock} */ (content.find(b => b.type === "quote"));
    assert.ok(quote, "Should have quote block");
    assert.ok(
      quote.content.some(b => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "[Quoted image]"),
      "Should fall back to text placeholder",
    );
  });

  it("returns undefined quotedSenderId when no quote", async () => {
    const msg = /** @type {Partial<BaileysMessage>} */ ({
      message: { conversation: "Hello" },
    });
    const { quotedSenderId } = await getMessageContent(msg);
    assert.equal(quotedSenderId, undefined);
  });
});

describe("createConfirmRegistry", () => {
  it("resolves true on thumbs-up reaction and shows checkmark", async () => {
    const { sock, registry, reactions, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    // Allow the async sendMessage to complete
    await new Promise(r => setTimeout(r, 10));

    // Emit 👍 on the message
    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4D" });

    const result = await promise;
    assert.equal(result, true);
    assert.ok(reactions.some(r => r.text === "✅"), "Should react with ✅");
  });

  it("resolves false on thumbs-down reaction and shows X", async () => {
    const { sock, registry, reactions, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    await new Promise(r => setTimeout(r, 10));

    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4E" });

    const result = await promise;
    assert.equal(result, false);
    assert.ok(reactions.some(r => r.text === "❌"), "Should react with ❌");
  });

  it("shows hourglass reaction immediately (not countdown)", async () => {
    const { sock, registry, reactions, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    await new Promise(r => setTimeout(r, 10));

    // Should have ⏳ as the first/only reaction
    assert.ok(reactions.some(r => r.text === "⏳"), "Should react with ⏳");
    // Should NOT have any countdown emojis
    assert.ok(!reactions.some(r => r.text === "🔟"), "Should not have countdown emojis");

    // Clean up: resolve the promise
    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4D" });
    await promise;
  });

  it("does NOT auto-resolve within short timeframes", async () => {
    const { sock, registry, reactions, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    await new Promise(r => setTimeout(r, 10));

    // Wait 200ms — promise should still be pending (30min safety timeout)
    let resolved = false;
    promise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(resolved, false, "Promise should not auto-resolve");

    // No ❌ from timeout
    assert.ok(!reactions.some(r => r.text === "❌"), "Should not have auto-cancelled");

    // Clean up
    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4D" });
    await promise;
  });

  it("calls onSent hook with message key after sending", async () => {
    const { sock, registry, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    /** @type {any} */
    let sentKey = null;
    const promise = confirm("Confirm?", {
      onSent: async (key) => { sentKey = key; },
    });
    await new Promise(r => setTimeout(r, 10));

    assert.ok(sentKey, "onSent should have been called");
    assert.equal(sentKey.id, "msg-0");
    assert.equal(sentKey.remoteJid, "test-chat");

    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4D" });
    await promise;
  });

  it("calls onResolved hook with (msgKey, confirmed) after reaction", async () => {
    const { sock, registry, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    /** @type {any[]} */
    const resolvedCalls = [];
    const promise = confirm("Confirm?", {
      onResolved: async (key, confirmed) => { resolvedCalls.push({ key, confirmed }); },
    });
    await new Promise(r => setTimeout(r, 10));

    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4E" });
    await promise;

    assert.equal(resolvedCalls.length, 1);
    assert.equal(resolvedCalls[0].key.id, "msg-0");
    assert.equal(resolvedCalls[0].confirmed, false);
  });

  it("removes pending entry after resolution", async () => {
    const { sock, registry, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm?");
    await new Promise(r => setTimeout(r, 10));

    assert.equal(registry.size, 1, "Should have one pending confirmation");
    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4D" });
    await promise;
    assert.equal(registry.size, 0, "Should have no pending confirmations after resolution");
  });

  it("ignores non-matching reactions without leaking", async () => {
    const { sock, registry, emitReaction } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm?");
    await new Promise(r => setTimeout(r, 10));

    // Send a heart reaction — should be ignored
    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "❤️" });
    assert.equal(registry.size, 1, "Should still have pending confirmation after non-matching reaction");

    // Now resolve properly
    emitReaction({ id: "msg-0", remoteJid: "test-chat" }, { text: "\uD83D\uDC4D" });
    await promise;
    assert.equal(registry.size, 0, "Should be clean after resolution");
  });

  it("clear() resolves all pending as false", async () => {
    const { sock, registry } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise1 = confirm("First?");
    await new Promise(r => setTimeout(r, 10));
    const promise2 = confirm("Second?");
    await new Promise(r => setTimeout(r, 10));

    assert.equal(registry.size, 2, "Should have two pending confirmations");
    registry.clear();

    const [r1, r2] = await Promise.all([promise1, promise2]);
    assert.equal(r1, false, "First should resolve false on clear");
    assert.equal(r2, false, "Second should resolve false on clear");
    assert.equal(registry.size, 0, "Should be empty after clear");
  });
});
