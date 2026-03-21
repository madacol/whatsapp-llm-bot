import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUpsertReactionMessage } from "../whatsapp/create-whatsapp-transport.js";
import { createReactionRuntime } from "../whatsapp/runtime/reaction-runtime.js";

describe("normalizeUpsertReactionMessage", () => {
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

  it("ignores non-reaction upserts", () => {
    assert.deepEqual(normalizeUpsertReactionMessage(/** @type {BaileysMessage} */ ({
      key: {
        remoteJid: "chat@s.whatsapp.net",
        fromMe: false,
        id: "msg-1",
      },
      message: {
        conversation: "hello",
      },
    })), []);
  });
});
