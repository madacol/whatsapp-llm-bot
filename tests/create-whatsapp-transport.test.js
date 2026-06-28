import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhatsAppUpsertShapeDiagnostic,
  captureWhatsAppMessageUpdateEvent,
  captureWhatsAppReactionEvent,
  captureWhatsAppReactionRuntimeEvent,
  captureWhatsAppUpsertEvent,
  createWhatsAppAlbumCoordinator,
} from "../whatsapp/create-whatsapp-transport.js";
import {
  classifyIncomingMessageEvent,
  normalizeReactionEvents,
  normalizeUpsertReactionMessage,
} from "../whatsapp/inbound/message-event-classifier.js";
import { createReactionRuntime } from "../whatsapp/runtime/reaction-runtime.js";

describe("WhatsApp upsert shape diagnostics", () => {
  it("summarizes album linkage without media secrets", () => {
    const diagnostic = buildWhatsAppUpsertShapeDiagnostic(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "chat@g.us",
        fromMe: false,
        id: "child-1",
        participant: "user@s.whatsapp.net",
      },
      messageTimestamp: 1777375800,
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          caption: "first image",
          mediaKey: Buffer.from("secret-media-key"),
          url: "https://media.example.test/secret",
          contextInfo: {
            pairedMediaType: 3,
          },
        },
        messageContextInfo: {
          messageSecret: Buffer.from("secret"),
          messageAssociation: {
            associationType: 1,
            parentMessageKey: {
              remoteJid: "chat@g.us",
              fromMe: false,
              id: "album-parent",
            },
            messageIndex: 2,
          },
        },
      },
    }));

    assert.deepEqual(diagnostic.messageTypes, ["imageMessage", "messageContextInfo"]);
    assert.deepEqual(diagnostic.messageContextInfo, {
      hasMessageSecret: true,
      messageSecretLength: 6,
      messageAssociation: {
        associationType: 1,
        parentMessageKey: {
          remoteJid: "chat@g.us",
          fromMe: false,
          id: "album-parent",
          participant: null,
        },
        messageIndex: 2,
      },
    });
    assert.deepEqual(diagnostic.imageMessage, {
      mimetype: "image/jpeg",
      caption: "first image",
      contextInfo: {
        stanzaId: null,
        participant: null,
        remoteJid: null,
        pairedMediaType: 3,
        quotedMessageTypes: [],
      },
    });
    assert.equal(JSON.stringify(diagnostic).includes("secret-media-key"), false);
    assert.equal(JSON.stringify(diagnostic).includes("media.example.test"), false);
  });

  it("captures WhatsApp inbound and reaction seam payloads through fixture capture", () => {
    /** @type {Array<Record<string, unknown>>} */
    const captured = [];
    const fixtureCapture = {
      /** @param {Record<string, unknown>} entry */
      capture(entry) {
        captured.push(structuredClone(entry));
      },
      waitForIdle: async () => {},
    };
    const message = /** @type {BaileysMessage} */ ({
      key: { remoteJid: "chat@g.us", fromMe: false, id: "msg-1" },
      message: { conversation: "hello" },
    });

    captureWhatsAppUpsertEvent({ type: "notify", messages: [message] }, { fixtureCapture });
    captureWhatsAppMessageUpdateEvent([{ key: { id: "poll-1", remoteJid: "chat@g.us" }, update: { pollUpdates: [] } }], { fixtureCapture });
    captureWhatsAppReactionEvent([{ key: { id: "msg-1", remoteJid: "chat@g.us" }, reaction: { text: "👁" } }], { fixtureCapture });
    captureWhatsAppReactionRuntimeEvent(
      {
        type: "reaction.received",
        messageId: "msg-1",
        remoteJid: "chat@g.us",
        emoji: "👁",
        senderId: "user@s.whatsapp.net",
        listenerCount: 1,
      },
      { fixtureCapture },
    );

    assert.deepEqual(
      captured.map((entry) => [entry.seam, entry.direction, entry.event]),
      [
        ["whatsapp.inbound", "baileys_to_shell", "messages.upsert"],
        ["whatsapp.inbound", "baileys_to_shell", "messages.update"],
        ["whatsapp.reaction", "baileys_to_shell", "messages.reaction"],
        ["whatsapp.reaction", "runtime", "reaction.received"],
      ],
    );
    assert.deepEqual(/** @type {{ payload?: { messages?: unknown[] } }} */ (captured[0]).payload?.messages, [message]);
  });
});

describe("WhatsApp album coordinator", () => {
  it("buffers album children and flushes them together when the expected count arrives", async () => {
    /** @type {BaileysMessage[][]} */
    const flushedAlbums = [];
    const coordinator = createWhatsAppAlbumCoordinator({
      flushDelayMs: 10_000,
      handleAlbumMessages: async (messages) => {
        flushedAlbums.push(messages);
      },
    });
    const chatId = "chat@g.us";
    const parentId = "album-parent";

    assert.equal(await coordinator.handle(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: chatId,
        fromMe: false,
        id: parentId,
      },
      message: {
        albumMessage: {
          expectedImageCount: 4,
          expectedVideoCount: 0,
        },
      },
    })), true);

    for (const childId of ["image-1", "image-2", "image-3", "image-4"]) {
      assert.equal(await coordinator.handle(/** @type {BaileysMessage} */ ({
        key: {
          remoteJid: chatId,
          fromMe: false,
          id: childId,
        },
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
          },
          messageContextInfo: {
            messageAssociation: {
              associationType: 1,
              parentMessageKey: {
                remoteJid: chatId,
                fromMe: true,
                id: parentId,
              },
            },
          },
        },
      })), true);
    }

    assert.equal(flushedAlbums.length, 1);
    assert.deepEqual(flushedAlbums[0].map((message) => message.key.id), [
      "image-1",
      "image-2",
      "image-3",
      "image-4",
    ]);
  });

  it("does not consume ordinary messages", async () => {
    const coordinator = createWhatsAppAlbumCoordinator({
      handleAlbumMessages: async () => {
        assert.fail("ordinary messages should not flush as albums");
      },
    });

    assert.equal(await coordinator.handle(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "chat@g.us",
        fromMe: false,
        id: "plain-message",
      },
      message: {
        conversation: "hello",
      },
    })), false);
  });
});

describe("message-event-classifier", () => {
  it("preserves fromMe on dedicated reaction events", () => {
    const normalized = normalizeReactionEvents([{
      key: {
        id: "msg-1",
        remoteJid: "chat@g.us",
        fromMe: true,
      },
      reaction: { text: "👁" },
    }]);

    assert.deepEqual(normalized, [{
      key: { id: "msg-1", remoteJid: "chat@g.us" },
      reaction: { text: "👁" },
      senderId: "chat",
      fromMe: true,
    }]);
  });

  it("extracts reaction-message upserts into runtime reaction events", () => {
    const normalized = normalizeUpsertReactionMessage(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "120363042584279820@g.us",
        fromMe: false,
        id: "AC2F279DD488C7602455FA6C13CD67DA",
        participant: "213597330374785@lid",
        participantAlt: "393792375735@s.whatsapp.net",
        addressingMode: "lid",
      },
      message: {
        reactionMessage: {
          key: {
            remoteJid: "120363042584279820@g.us",
            fromMe: true,
            id: "3EB059407A39C3E611C2B4",
            participant: "147025689575646@lid",
          },
          text: "👁",
          senderTimestampMs: 1774137275097,
        },
      },
    }));

    assert.deepEqual(normalized, [{
      key: {
        id: "3EB059407A39C3E611C2B4",
        remoteJid: "120363042584279820@g.us",
      },
      reaction: { text: "👁" },
      senderId: "213597330374785",
      senderIds: ["213597330374785", "393792375735"],
      fromMe: false,
    }]);

    const reactionRuntime = createReactionRuntime();
    /** @type {{ emoji: string, senderId: string } | null} */
    let received = null;
    reactionRuntime.subscribe("3EB059407A39C3E611C2B4", (emoji, senderId) => {
      received = { emoji, senderId };
    });
    reactionRuntime.handleReactions(normalized);

    assert.deepEqual(received, {
      emoji: "👁",
      senderId: "213597330374785",
    });
  });

  it("preserves fromMe on reaction-message upserts", () => {
    const normalized = normalizeUpsertReactionMessage(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "user@s.whatsapp.net",
        fromMe: true,
        id: "self-reaction-msg",
      },
      message: {
        reactionMessage: {
          key: {
            remoteJid: "user@s.whatsapp.net",
            fromMe: true,
            id: "inspectable-msg",
          },
          text: "👁",
        },
      },
    }));

    assert.deepEqual(normalized, [{
      key: {
        id: "inspectable-msg",
        remoteJid: "user@s.whatsapp.net",
      },
      reaction: { text: "👁" },
      senderId: "user",
      fromMe: true,
    }]);
  });

  it("classifies reaction-message upserts as reaction events", () => {
    const event = classifyIncomingMessageEvent(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "chat@g.us",
        fromMe: false,
        id: "msg-1",
        participant: "user@lid",
      },
      message: {
        reactionMessage: {
          key: {
            remoteJid: "chat@g.us",
            id: "tool-msg-1",
          },
          text: "👁",
        },
      },
    }));

    assert.deepEqual(event, {
      kind: "reaction",
      reactions: [{
        key: { id: "tool-msg-1", remoteJid: "chat@g.us" },
        reaction: { text: "👁" },
        senderId: "user",
        fromMe: false,
      }],
    });
  });

  it("classifies poll updates separately from normal turns", () => {
    const event = classifyIncomingMessageEvent(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "chat@g.us",
        fromMe: false,
        id: "msg-poll-1",
      },
      message: {
        pollUpdateMessage: /** @type {Record<string, unknown>} */ ({}),
      },
    }));

    assert.equal(event.kind, "poll_update");
    if (event.kind === "poll_update") {
      assert.equal(event.message.key.id, "msg-poll-1");
    }
  });

  it("ignores status broadcasts before channel input parsing", () => {
    assert.deepEqual(
      classifyIncomingMessageEvent(/** @type {BaileysMessage} */ ({
        key: {
          remoteJid: "status@broadcast",
          fromMe: false,
          id: "status-1",
        },
        message: {
          conversation: "status update",
        },
      })),
      { kind: "ignore" },
    );
  });

  it("classifies non-reaction upserts as channel input", () => {
    const event = classifyIncomingMessageEvent(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "chat@s.whatsapp.net",
        fromMe: false,
        id: "msg-1",
      },
      message: {
        conversation: "hello",
      },
    }));

    assert.equal(event.kind, "channel_input");
  });

  it("normalizes direct reaction events with participantAlt fallback", () => {
    assert.deepEqual(
      normalizeReactionEvents([{
        key: {
          id: "msg-1",
          remoteJid: "chat@g.us",
          participantAlt: "fallback@s.whatsapp.net",
        },
        reaction: { text: "👁" },
      }]),
      [{
        key: { id: "msg-1", remoteJid: "chat@g.us" },
        reaction: { text: "👁" },
        senderId: "fallback",
      }],
    );
  });
});
