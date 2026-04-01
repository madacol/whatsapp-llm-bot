import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { proto } from "@whiskeysockets/baileys";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createTestDb, seedChat } from "./helpers.js";
import { setDb } from "../db.js";
import { readBlockBase64 } from "../media-store.js";

/** @type {typeof import("../whatsapp/inbound/message-content.js").getMessageContent} */
let getMessageContent;

/** @type {typeof import("../whatsapp/runtime/confirm-runtime.js").createConfirmRuntime} */
let createConfirmRuntime;

/** @type {typeof import("../whatsapp/runtime/select-runtime.js").createSelectRuntime} */
let createSelectRuntime;
/** @type {typeof import("../whatsapp/runtime/reaction-runtime.js").createReactionRuntime} */
let createReactionRuntime;

/** @type {typeof import("../whatsapp/inbound/chat-turn.js").adaptIncomingMessage} */
let adaptIncomingMessage;
/** @type {typeof import("../whatsapp/inbound/chat-turn.js").createTurnIo} */
let createTurnIo;

before(async () => {
  // Seed DB cache so initStore() in index.js uses in-memory DB
  const testDb = await createTestDb();
  setDb("./pgdata/root", testDb);

  ({ getMessageContent } = await import("../whatsapp/inbound/message-content.js"));
  ({ createConfirmRuntime } = await import("../whatsapp/runtime/confirm-runtime.js"));
  ({ createSelectRuntime } = await import("../whatsapp/runtime/select-runtime.js"));
  ({ createReactionRuntime } = await import("../whatsapp/runtime/reaction-runtime.js"));
  ({ adaptIncomingMessage, createTurnIo } = await import("../whatsapp/inbound/chat-turn.js"));
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
 * @returns {{
 *   sock: any,
 *   registry: ReturnType<typeof createConfirmRuntime>,
 *   sentMessages: Array<{ chatId: string, msg: any, key: { id: string, remoteJid: string }, options?: Record<string, unknown> }>,
 *   reactions: any[],
 *   emitPollVote: (pollMsgId: string, selectedOptions: string[]) => void,
 * }}
 */
function createMockSock() {
  /** @type {Array<{ chatId: string, msg: any, key: { id: string, remoteJid: string }, options?: Record<string, unknown> }>} */
  const sentMessages = [];
  /** @type {any[]} */
  const reactions = [];

  const sock = {
    sendMessage: async (/** @type {string} */ chatId, /** @type {any} */ msg, /** @type {Record<string, unknown> | undefined} */ options) => {
      if (msg.react) {
        reactions.push(msg.react);
        return null;
      }
      const key = { id: `msg-${sentMessages.length}`, remoteJid: chatId };
      sentMessages.push({ chatId, msg, key, options });
      return { key };
    },
  };

  const registry = createConfirmRuntime();

  return {
    sock,
    registry,
    sentMessages,
    reactions,
    /** Route a poll vote through the registry. */
    emitPollVote: (/** @type {string} */ pollMsgId, /** @type {string[]} */ selectedOptions) => {
      registry.handlePollVote({ chatId: "test-chat", pollMsgId, selectedOptions });
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
    assert.equal(await readBlockBase64(imageBlock), fakeBuffer.toString("base64"));
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
    const confirmRegistry = createConfirmRuntime();
    const userResponseRegistry = createSelectRuntime();
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

    const resolvedHd = await withTimeout(firstImage.getHd ?? Promise.resolve(null), 50);
    assert.ok(resolvedHd && resolvedHd !== "timeout");
    assert.equal(resolvedHd.type, "image");
    assert.equal(resolvedHd.mime_type, "image/jpeg");
    assert.equal(await readBlockBase64(resolvedHd), Buffer.from("hd-child-1").toString("base64"));
    assert.equal(await withTimeout(secondImage.getHd ?? Promise.resolve(null), 50), "timeout");
  });
});

describe("createTurnIo", () => {
  it("sends reply events as plain messages instead of quoted replies", async () => {
    const { sock, registry, sentMessages } = createMockSock();
    const io = createTurnIo({
      sock,
      chatId: "test-chat",
      message: /** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "test-chat",
          fromMe: false,
          id: "incoming-msg-1",
        },
      }),
      senderIds: ["sender-1"],
      isGroup: false,
      selectRuntime: createSelectRuntime(),
      confirmRuntime: registry,
      reactionRuntime: createReactionRuntime(),
    });

    await io.reply({
      kind: "content",
      source: "llm",
      content: "Plain send",
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.options?.quoted, undefined);
  });

  it("routes outbound replies through the latest live socket after reconnect", async () => {
    const oldSocket = createMockSock();
    const newSocket = createMockSock();
    /** @type {BaileysSocket | null} */
    let currentSocket = oldSocket.sock;

    const io = createTurnIo({
      sock: oldSocket.sock,
      getSocket: () => currentSocket,
      chatId: "test-chat",
      message: /** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "test-chat",
          fromMe: false,
          id: "incoming-msg-2",
        },
      }),
      senderIds: ["sender-1"],
      isGroup: false,
      selectRuntime: createSelectRuntime(),
      confirmRuntime: oldSocket.registry,
      reactionRuntime: createReactionRuntime(),
    });

    currentSocket = newSocket.sock;
    await io.reply({
      kind: "content",
      source: "llm",
      content: "Recovered send",
    });

    assert.equal(oldSocket.sentMessages.length, 0);
    assert.equal(newSocket.sentMessages.length, 1);
  });

  it("opens a lease, pulses composing on the adapter cadence, then pauses on expiry", async () => {
    /** @type {Array<{ presence: string, chatId: string }>} */
    const presenceUpdates = [];
    const io = createTurnIo({
      sock: /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
        sendMessage: async () => ({ key: { id: "sent-1", remoteJid: "presence-chat" } }),
        sendPresenceUpdate: async (presence, chatId) => {
          presenceUpdates.push({ presence, chatId });
        },
      })),
      chatId: "presence-chat",
      message: /** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "presence-chat",
          fromMe: false,
          id: "incoming-msg-3",
        },
      }),
      senderIds: ["sender-1"],
      isGroup: false,
      selectRuntime: createSelectRuntime(),
      confirmRuntime: createConfirmRuntime(),
      reactionRuntime: createReactionRuntime(),
      presenceConfig: {
        defaultLeaseTtlMs: 20,
        pulseIntervalMs: 5,
      },
    });

    await io.startPresence(18);
    await new Promise((resolve) => setTimeout(resolve, 24));

    assert.ok(
      presenceUpdates.filter((update) => update.presence === "composing").length >= 2,
      `Expected adapter-managed composing pulses, got: ${JSON.stringify(presenceUpdates)}`,
    );
    assert.equal(
      presenceUpdates.at(-1)?.presence,
      "paused",
      `Expected expiry to end with paused, got: ${JSON.stringify(presenceUpdates)}`,
    );
  });

  it("treats keepAlive as a lease refresh when active and as a new lease when inactive", async () => {
    /** @type {Array<{ presence: string, chatId: string }>} */
    const presenceUpdates = [];
    const io = createTurnIo({
      sock: /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
        sendMessage: async () => ({ key: { id: "sent-2", remoteJid: "presence-chat" } }),
        sendPresenceUpdate: async (presence, chatId) => {
          presenceUpdates.push({ presence, chatId });
        },
      })),
      chatId: "presence-chat",
      message: /** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "presence-chat",
          fromMe: false,
          id: "incoming-msg-4",
        },
      }),
      senderIds: ["sender-1"],
      isGroup: false,
      selectRuntime: createSelectRuntime(),
      confirmRuntime: createConfirmRuntime(),
      reactionRuntime: createReactionRuntime(),
      presenceConfig: {
        defaultLeaseTtlMs: 20,
        pulseIntervalMs: 50,
      },
    });

    await io.startPresence(20);
    presenceUpdates.length = 0;

    await io.keepPresenceAlive();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      presenceUpdates,
      [],
      `Expected active keepAlive to refresh only the lease, got: ${JSON.stringify(presenceUpdates)}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 22));
    assert.equal(presenceUpdates.at(-1)?.presence, "paused");

    presenceUpdates.length = 0;
    await io.keepPresenceAlive();

    assert.deepEqual(presenceUpdates, [{
      presence: "composing",
      chatId: "presence-chat",
    }]);

    await io.endPresence();
  });

  it("re-sends composing after outbound messages while the lease is active", async () => {
    /** @type {Array<{ presence: string, chatId: string }>} */
    const presenceUpdates = [];
    /** @type {Array<{ chatId: string, msg: Record<string, unknown>, options?: Record<string, unknown> }>} */
    const sentMessages = [];
    const io = createTurnIo({
      sock: /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
        sendMessage: async (chatId, msg, options) => {
          sentMessages.push({ chatId, msg, options });
          return { key: { id: "sent-3", remoteJid: chatId } };
        },
        sendPresenceUpdate: async (presence, chatId) => {
          presenceUpdates.push({ presence, chatId });
        },
      })),
      chatId: "presence-chat",
      message: /** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "presence-chat",
          fromMe: false,
          id: "incoming-msg-5",
        },
      }),
      senderIds: ["sender-1"],
      isGroup: false,
      selectRuntime: createSelectRuntime(),
      confirmRuntime: createConfirmRuntime(),
      reactionRuntime: createReactionRuntime(),
      presenceConfig: {
        defaultLeaseTtlMs: 50,
        pulseIntervalMs: 500,
      },
    });

    await io.startPresence(50);
    presenceUpdates.length = 0;

    await io.reply({
      kind: "content",
      source: "llm",
      content: "Still working",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sentMessages.length, 1);
    assert.deepEqual(presenceUpdates, [{
      presence: "composing",
      chatId: "presence-chat",
    }]);

    await io.endPresence();
  });

  it("ends the active lease before select prompts", async () => {
    /** @type {Array<{ presence: string, chatId: string }>} */
    const presenceUpdates = [];
    const selectRuntime = createSelectRuntime();
    const io = createTurnIo({
      sock: /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
        sendMessage: async (chatId) => ({ key: { id: `sent-${chatId}`, remoteJid: chatId } }),
        sendPresenceUpdate: async (presence, chatId) => {
          presenceUpdates.push({ presence, chatId });
        },
      })),
      chatId: "presence-chat",
      message: /** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "presence-chat",
          fromMe: false,
          id: "incoming-msg-6",
        },
      }),
      senderIds: ["sender-1"],
      isGroup: false,
      selectRuntime,
      confirmRuntime: createConfirmRuntime(),
      reactionRuntime: createReactionRuntime(),
      presenceConfig: {
        defaultLeaseTtlMs: 50,
        pulseIntervalMs: 5,
      },
    });

    await io.startPresence(50);
    presenceUpdates.length = 0;

    const selectPromise = io.select("Choose one", ["A", "B"]);
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.deepEqual(presenceUpdates, [{
      presence: "paused",
      chatId: "presence-chat",
    }]);

    selectRuntime.clear();
    await selectPromise;
  });

  it("ends the active lease before confirm prompts", async () => {
    /** @type {Array<{ presence: string, chatId: string }>} */
    const presenceUpdates = [];
    const confirmRuntime = createConfirmRuntime();
    const io = createTurnIo({
      sock: /** @type {import("@whiskeysockets/baileys").WASocket} */ (/** @type {unknown} */ ({
        sendMessage: async (chatId) => ({ key: { id: `sent-${chatId}`, remoteJid: chatId } }),
        sendPresenceUpdate: async (presence, chatId) => {
          presenceUpdates.push({ presence, chatId });
        },
      })),
      chatId: "presence-chat",
      message: /** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "presence-chat",
          fromMe: false,
          id: "incoming-msg-7",
        },
      }),
      senderIds: ["sender-1"],
      isGroup: false,
      selectRuntime: createSelectRuntime(),
      confirmRuntime,
      reactionRuntime: createReactionRuntime(),
      presenceConfig: {
        defaultLeaseTtlMs: 50,
        pulseIntervalMs: 5,
      },
    });

    await io.startPresence(50);
    presenceUpdates.length = 0;

    const confirmPromise = io.confirm("Continue?");
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.deepEqual(presenceUpdates, [{
      presence: "paused",
      chatId: "presence-chat",
    }]);

    confirmRuntime.clear();
    await confirmPromise;
  });
});

describe("HD receive integration", () => {
  it("normalizes sender JIDs from LID addressing before exposing the turn", async () => {
    const rawChatId = "147025689575646@lid";
    const normalizedChatId = "353833927239@s.whatsapp.net";
    const confirmRegistry = createConfirmRuntime();
    const userResponseRegistry = createSelectRuntime();
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

    await adaptIncomingMessage(
      /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
        key: {
          remoteJid: rawChatId,
          fromMe: false,
          id: "lid-turn-1",
          senderLid: rawChatId,
          senderPid: normalizedChatId,
        },
        message: {
          conversation: "!new asd",
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: "LID User",
      })),
      sock,
      async (ctx) => {
        assert.equal(ctx.chatId, normalizedChatId);
        assert.deepEqual(ctx.senderJids, [normalizedChatId]);
      },
      confirmRegistry,
      userResponseRegistry,
    );
  });

  it("normalizes HD child chat IDs before resolving the pending parent upgrade", async () => {
    const rawChatId = "12345@lid";
    const normalizedChatId = "12345@s.whatsapp.net";
    const parentMessageId = "lid-parent-1";
    const SD_PARENT = proto.ContextInfo.PairedMediaType.SD_IMAGE_PARENT;
    const HD_CHILD = proto.ContextInfo.PairedMediaType.HD_IMAGE_CHILD;
    /** @type {ImageContentBlock | null} */
    let parentImage = null;
    const confirmRegistry = createConfirmRuntime();
    const userResponseRegistry = createSelectRuntime();
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

    const resolvedHd = await withTimeout(parentImage.getHd, 100);
    assert.ok(resolvedHd && resolvedHd !== "timeout");
    assert.equal(resolvedHd.type, "image");
    assert.equal(resolvedHd.mime_type, "image/jpeg");
    assert.equal(await readBlockBase64(resolvedHd), Buffer.from("lid-child-1").toString("base64"));
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

    const confirmRegistry = createConfirmRuntime();
    const userResponseRegistry = createSelectRuntime();
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

describe("createConfirmRuntime", () => {
  it("sends a confirm/cancel poll and resolves true on confirm vote", async () => {
    const { sock, registry, sentMessages, reactions, emitPollVote } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    await new Promise(r => setTimeout(r, 10));

    assert.equal(sentMessages.length, 1, "confirm() should send one poll prompt");
    assert.deepEqual(sentMessages[0]?.msg.poll, {
      name: "Confirm this?",
      values: ["Confirm", "Cancel ❌"],
      selectableCount: 1,
    });
    assert.equal(reactions.length, 0, "confirm() should not use reaction status markers");

    emitPollVote("msg-0", ["Confirm"]);

    const result = await promise;
    assert.equal(result, true);
  });

  it("resolves false on cancel vote", async () => {
    const { sock, registry, reactions, emitPollVote } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    await new Promise(r => setTimeout(r, 10));

    emitPollVote("msg-0", ["Cancel ❌"]);

    const result = await promise;
    assert.equal(result, false);
    assert.equal(reactions.length, 0, "cancel should not add reaction side effects");
  });

  it("does not send any reaction markers while pending", async () => {
    const { sock, registry, reactions, emitPollVote } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    await new Promise(r => setTimeout(r, 10));

    assert.equal(reactions.length, 0, "poll-backed confirm should not send pending reactions");

    emitPollVote("msg-0", ["Confirm"]);
    await promise;
  });

  it("does NOT auto-resolve within short timeframes", async () => {
    const { sock, registry, reactions, emitPollVote } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm this?");
    await new Promise(r => setTimeout(r, 10));

    // Wait 200ms — promise should still be pending (30min safety timeout)
    let resolved = false;
    promise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(resolved, false, "Promise should not auto-resolve");
    assert.equal(reactions.length, 0, "pending confirm should still avoid reaction side effects");

    // Clean up
    emitPollVote("msg-0", ["Confirm"]);
    await promise;
  });

  it("calls onSent hook with message key after sending", async () => {
    const { sock, registry, emitPollVote } = createMockSock();
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

    emitPollVote("msg-0", ["Confirm"]);
    await promise;
  });

  it("calls onResolved hook with (msgKey, confirmed) after poll vote", async () => {
    const { sock, registry, emitPollVote } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    /** @type {any[]} */
    const resolvedCalls = [];
    const promise = confirm("Confirm?", {
      onResolved: async (key, confirmed) => { resolvedCalls.push({ key, confirmed }); },
    });
    await new Promise(r => setTimeout(r, 10));

    emitPollVote("msg-0", ["Cancel ❌"]);
    await promise;

    assert.equal(resolvedCalls.length, 1);
    assert.equal(resolvedCalls[0].key.id, "msg-0");
    assert.equal(resolvedCalls[0].confirmed, false);
  });

  it("removes pending entry after resolution", async () => {
    const { sock, registry, emitPollVote } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm?");
    await new Promise(r => setTimeout(r, 10));

    assert.equal(registry.size, 1, "Should have one pending confirmation");
    emitPollVote("msg-0", ["Confirm"]);
    await promise;
    assert.equal(registry.size, 0, "Should have no pending confirmations after resolution");
  });

  it("ignores non-matching poll options without leaking", async () => {
    const { sock, registry, emitPollVote } = createMockSock();
    const confirm = registry.createConfirm(sock, "test-chat");

    const promise = confirm("Confirm?");
    await new Promise(r => setTimeout(r, 10));

    emitPollVote("msg-0", ["Maybe later"]);
    assert.equal(registry.size, 1, "Should still have pending confirmation after non-matching vote");

    emitPollVote("msg-0", ["Confirm"]);
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

  it("uses the latest live socket when a confirm prompt is sent after reconnect", async () => {
    const oldSocket = createMockSock();
    const newSocket = createMockSock();
    /** @type {BaileysSocket | null} */
    let currentSocket = oldSocket.sock;

    const confirm = oldSocket.registry.createConfirm(() => currentSocket, "test-chat");

    currentSocket = newSocket.sock;
    const promise = confirm("Confirm this?");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(oldSocket.sentMessages.length, 0);
    assert.equal(newSocket.sentMessages.length, 1);
    assert.deepEqual(newSocket.sentMessages[0]?.msg.poll, {
      name: "Confirm this?",
      values: ["Confirm", "Cancel ❌"],
      selectableCount: 1,
    });

    oldSocket.registry.handlePollVote({
      chatId: "test-chat",
      pollMsgId: "msg-0",
      selectedOptions: ["Confirm"],
    });
    await promise;
  });
});
