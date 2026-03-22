import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIncomingMessageEvent,
  normalizeReactionEvents,
  normalizeUpsertReactionMessage,
} from "../whatsapp/inbound/message-event-classifier.js";
import { createReactionRuntime } from "../whatsapp/runtime/reaction-runtime.js";

describe("message-event-classifier", () => {
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
          senderTimestampMs: "1774137275097",
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

  it("ignores status broadcasts before turn parsing", () => {
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

  it("ignores non-reaction upserts", () => {
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

    assert.equal(event.kind, "turn");
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
