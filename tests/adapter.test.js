import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { proto } from "@whiskeysockets/baileys";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb, seedChat } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {typeof import("../whatsapp-adapter.js").getMessageContent} */
let getMessageContent;

/** @type {typeof import("../whatsapp-adapter.js").createConfirmRegistry} */
let createConfirmRegistry;

/** @type {typeof import("../whatsapp-adapter.js").createUserResponseRegistry} */
let createUserResponseRegistry;

/** @type {typeof import("../whatsapp-adapter.js").adaptIncomingMessage} */
let adaptIncomingMessage;

before(async () => {
  // Seed DB cache so initStore() in index.js uses in-memory DB
  const testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  const adapter = await import("../whatsapp-adapter.js");
  getMessageContent = adapter.getMessageContent;
  createConfirmRegistry = adapter.createConfirmRegistry;
  createUserResponseRegistry = adapter.createUserResponseRegistry;
  adaptIncomingMessage = adapter.adaptIncomingMessage;
});

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T | "timeout">}
 */
function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
}

/**
 * @param {object} params
 * @param {string} params.chatId
 * @param {string} params.messageId
 * @param {number} params.pairedMediaType
 * @param {string} [params.parentMessageId]
 * @param {string} [params.mediaKey]
 * @returns {BaileysMessage}
 */
function createHdImageMessage({ chatId, messageId, pairedMediaType, parentMessageId, mediaKey = "bWVkaWEta2V5" }) {
  /** @type {Record<string, unknown>} */
  const message = {
    imageMessage: {
      mimetype: "image/jpeg",
      url: `https://example.com/${messageId}.jpg`,
      directPath: `/v/t62.7118-24/${messageId}`,
      mediaKey,
      contextInfo: { pairedMediaType },
    },
  };

  if (parentMessageId) {
    message.associatedChildMessage = {
      message: message.imageMessage ? { imageMessage: message.imageMessage } : {},
    };
    delete message.imageMessage;
    message.messageContextInfo = {
      messageAssociation: {
        parentMessageKey: {
          remoteJid: chatId,
          id: parentMessageId,
        },
      },
    };
  }

  return /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
    key: {
      remoteJid: chatId,
      fromMe: false,
      id: messageId,
    },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "HD Tester",
  }));
}

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

  it("resolves HD children against their parent message ID when multiple parents are pending in one chat", async () => {
    const chatId = "multi-hd@s.whatsapp.net";
    const SD_PARENT = proto.ContextInfo.PairedMediaType.SD_IMAGE_PARENT;
    const HD_CHILD = proto.ContextInfo.PairedMediaType.HD_IMAGE_CHILD;
    const mockDownload = async (/** @type {BaileysMessage} */ message) => Buffer.from(message.key.id);
    /** @type {ImageContentBlock[]} */
    const parentImages = [];
    const confirmRegistry = createConfirmRegistry();
    const userResponseRegistry = createUserResponseRegistry();
    const sock = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot@s.whatsapp.net" },
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
        },
      },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {},
    }));

    await adaptIncomingMessage(
      createHdImageMessage({ chatId, messageId: "sd-parent-1", pairedMediaType: SD_PARENT }),
      sock,
      async (ctx) => {
        parentImages.push(/** @type {ImageContentBlock} */ (ctx.content.find((block) => block.type === "image")));
      },
      confirmRegistry,
      userResponseRegistry,
      undefined,
      mockDownload,
    );
    await adaptIncomingMessage(
      createHdImageMessage({ chatId, messageId: "sd-parent-2", pairedMediaType: SD_PARENT }),
      sock,
      async (ctx) => {
        parentImages.push(/** @type {ImageContentBlock} */ (ctx.content.find((block) => block.type === "image")));
      },
      confirmRegistry,
      userResponseRegistry,
      undefined,
      mockDownload,
    );

    const [firstImage, secondImage] = parentImages;

    assert.equal(firstImage._hdParentMessageId, "sd-parent-1");
    assert.equal(secondImage._hdParentMessageId, "sd-parent-2");

    await adaptIncomingMessage(
      createHdImageMessage({
        chatId,
        messageId: "hd-child-1",
        pairedMediaType: HD_CHILD,
        parentMessageId: "sd-parent-1",
      }),
      sock,
      async () => {
        assert.fail("HD child should not be passed to the message handler");
      },
      confirmRegistry,
      userResponseRegistry,
      undefined,
      mockDownload,
    );

    assert.deepEqual(
      await withTimeout(firstImage.getHd ?? Promise.resolve(null), 50),
      /** @type {ImageContentBlock} */ ({
        type: "image",
        encoding: "base64",
        mime_type: "image/jpeg",
        data: Buffer.from("hd-child-1").toString("base64"),
      }),
    );
    assert.equal(await withTimeout(secondImage.getHd ?? Promise.resolve(null), 50), "timeout");
  });
});

describe("HD receive integration", () => {
  it("normalizes HD child chat IDs before resolving the pending parent upgrade", async () => {
    const rawChatId = "12345@lid";
    const normalizedChatId = "12345@s.whatsapp.net";
    const parentMessageId = "lid-parent-1";
    const SD_PARENT = proto.ContextInfo.PairedMediaType.SD_IMAGE_PARENT;
    const HD_CHILD = proto.ContextInfo.PairedMediaType.HD_IMAGE_CHILD;
    /** @type {ImageContentBlock | null} */
    let parentImage = null;
    const confirmRegistry = createConfirmRegistry();
    const userResponseRegistry = createUserResponseRegistry();
    const sock = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot@s.whatsapp.net" },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => lid === rawChatId ? normalizedChatId : null,
        },
      },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {},
    }));
    const mockDownload = async (/** @type {BaileysMessage} */ message) => Buffer.from(message.key.id);

    await adaptIncomingMessage(
      createHdImageMessage({ chatId: rawChatId, messageId: parentMessageId, pairedMediaType: SD_PARENT }),
      sock,
      async (ctx) => {
        assert.equal(ctx.chatId, normalizedChatId);
        parentImage = /** @type {ImageContentBlock} */ (ctx.content.find((block) => block.type === "image"));
      },
      confirmRegistry,
      userResponseRegistry,
      undefined,
      mockDownload,
    );

    assert.ok(parentImage?.getHd, "Expected SD parent to expose a pending HD promise");

    await adaptIncomingMessage(
      createHdImageMessage({
        chatId: rawChatId,
        messageId: "lid-child-1",
        pairedMediaType: HD_CHILD,
        parentMessageId,
      }),
      sock,
      async () => {
        assert.fail("HD child should not be passed to the message handler");
      },
      confirmRegistry,
      userResponseRegistry,
      undefined,
      mockDownload,
    );

    assert.deepEqual(
      await withTimeout(parentImage.getHd, 100),
      /** @type {ImageContentBlock} */ ({
        type: "image",
        encoding: "base64",
        mime_type: "image/jpeg",
        data: Buffer.from("lid-child-1").toString("base64"),
      }),
    );
  });

  it("updates the stored _hdRef on the matching parent message instead of the newest pending image", async () => {
    const db = await createTestDb();
    const chatId = "persist-hd@s.whatsapp.net";
    const parentMessageId = "persist-parent-1";
    await seedChat(db, chatId);

    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES (
        ${chatId},
        ${"user-1"},
        ${{
          role: "user",
          content: [{
            type: "image",
            encoding: "base64",
            mime_type: "image/jpeg",
            data: "c2Qx",
            _hdRef: null,
            _hdParentMessageId: parentMessageId,
          }],
        }},
        ${new Date("2026-03-19T00:00:00.000Z")}
      )`;
    await db.sql`INSERT INTO messages(chat_id, sender_id, message_data, timestamp)
      VALUES (
        ${chatId},
        ${"user-1"},
        ${{
          role: "user",
          content: [{
            type: "image",
            encoding: "base64",
            mime_type: "image/jpeg",
            data: "c2Qy",
            _hdRef: null,
            _hdParentMessageId: "persist-parent-2",
          }],
        }},
        ${new Date("2026-03-19T00:00:01.000Z")}
      )`;

    const confirmRegistry = createConfirmRegistry();
    const userResponseRegistry = createUserResponseRegistry();
    const sock = /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
      user: { id: "bot@s.whatsapp.net" },
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
        },
      },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {},
    }));
    const childMessage = createHdImageMessage({
      chatId,
      messageId: "persist-child-1",
      pairedMediaType: proto.ContextInfo.PairedMediaType.HD_IMAGE_CHILD,
      parentMessageId,
      mediaKey: "cGVyc2lzdC1tZWRpYS1rZXk=",
    });

    await adaptIncomingMessage(
      childMessage,
      sock,
      async () => {
        assert.fail("HD child should not reach the message handler");
      },
      confirmRegistry,
      userResponseRegistry,
      undefined,
      async (/** @type {BaileysMessage} */ message) => Buffer.from(message.key.id),
    );

    const { rows } = await db.sql`SELECT message_data FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp ASC`;
    const firstRow = /** @type {{ message_data: UserMessage }} */ (rows[0]);
    const secondRow = /** @type {{ message_data: UserMessage }} */ (rows[1]);
    const firstImage = /** @type {ImageContentBlock} */ (firstRow.message_data.content[0]);
    const secondImage = /** @type {ImageContentBlock} */ (secondRow.message_data.content[0]);

    assert.deepEqual(firstImage._hdRef, {
      url: "https://example.com/persist-child-1.jpg",
      directPath: "/v/t62.7118-24/persist-child-1",
      mediaKey: "cGVyc2lzdC1tZWRpYS1rZXk=",
      mimetype: "image/jpeg",
    });
    assert.equal(secondImage._hdRef, null);
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
