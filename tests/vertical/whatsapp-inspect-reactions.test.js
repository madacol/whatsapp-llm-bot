import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { appMessageEvent, assistantOutputEvent } from "../../outbound-events.js";
import {
  createWhatsAppTransportTestbed,
  findSentTextMessageId,
  hasSentTextContaining,
  waitForCondition,
  whatsappReactionMessage,
  whatsappTextMessage,
} from "./whatsapp-transport-testbed.js";

const originalTesting = process.env.TESTING;
process.env.TESTING = "1";

const INSPECT_CHAT_ID = "120363042584279820@g.us";
const INSPECT_BOT_PHONE_JID = "393792375735@s.whatsapp.net";
const INSPECT_BOT_LID_JID = "147025689575646@lid";
const INSPECT_USER_LID_JID = "213597330374785@lid";
const INSPECT_USER_PHONE_JID = "555199900001@s.whatsapp.net";

after(() => {
  if (originalTesting === undefined) {
    delete process.env.TESTING;
  } else {
    process.env.TESTING = originalTesting;
  }
});

describe("WhatsApp inspect reactions", () => {
  it("keeps reasoning inspect hidden for bot marker echoes and reveals it for user eye reactions", async () => {
    const inspectText = "Inspectable reasoning should only show after a real user reaction.";
    const testbed = await createWhatsAppTransportTestbed({
      botPhoneJid: INSPECT_BOT_PHONE_JID,
      botLidJid: INSPECT_BOT_LID_JID,
    });

    try {
      await testbed.start(async (turn) => {
        const handle = await turn.io.reply(assistantOutputEvent([{ type: "text", text: "Thinking..." }]));
        assert.ok(handle, "Expected reasoning reply to return a message handle.");
        handle.setInspect({
          kind: "reasoning",
          summary: "*Thinking*",
          text: inspectText,
        });
      });

      await testbed.replayInboundCapture({
        type: "notify",
        messages: [
          whatsappTextMessage({
            chatId: INSPECT_CHAT_ID,
            text: "start reasoning",
            senderId: "vertical-user",
          }),
        ],
      });
      await waitForCondition(
        () => testbed.sentMessages.some((entry) => {
          const reaction = /** @type {{ react?: { text?: string } }} */ (entry.message).react;
          return reaction?.text === "👁";
        }),
        `Expected inspect marker reaction, got ${JSON.stringify(testbed.sentMessages)}`,
      );
      const reasoningMessageId = findSentTextMessageId(testbed.sentMessages, (text) => text.endsWith("Thinking..."));
      assert.equal(hasSentTextContaining(testbed.sentMessages, inspectText), false);

      await testbed.replayInboundCapture({
        type: "notify",
        messages: [
          whatsappReactionMessage({
            chatId: INSPECT_CHAT_ID,
            targetMessageId: reasoningMessageId,
            reaction: "👁",
            senderLidJid: INSPECT_BOT_LID_JID,
            senderPhoneJid: INSPECT_BOT_PHONE_JID,
            id: "MSG-VERTICAL-BOT-INSPECT-ECHO",
            targetParticipantJid: INSPECT_BOT_LID_JID,
          }),
        ],
      });
      assert.equal(hasSentTextContaining(testbed.sentMessages, inspectText), false);

      await testbed.replayInboundCapture({
        type: "notify",
        messages: [
          whatsappReactionMessage({
            chatId: INSPECT_CHAT_ID,
            targetMessageId: reasoningMessageId,
            reaction: "👁",
            senderLidJid: INSPECT_USER_LID_JID,
            senderPhoneJid: INSPECT_USER_PHONE_JID,
            id: "MSG-VERTICAL-USER-INSPECT",
            targetParticipantJid: INSPECT_BOT_LID_JID,
          }),
        ],
      });
      await waitForCondition(
        () => hasSentTextContaining(testbed.sentMessages, inspectText),
        `Expected user inspect reveal, got ${JSON.stringify(testbed.sentMessages)}`,
      );
    } finally {
      await testbed.stop();
    }
  });

  it("keeps audio transcription inspect hidden for bot marker echoes and reveals it for user eye reactions", async () => {
    const inspectText = "Audio transcript should only show after a real user reaction.";
    const testbed = await createWhatsAppTransportTestbed({
      botPhoneJid: INSPECT_BOT_PHONE_JID,
      botLidJid: INSPECT_BOT_LID_JID,
    });

    try {
      await testbed.start(async (turn) => {
        const handle = await turn.io.reply(
          appMessageEvent("plain", "Transcribing audio...", { replyToTriggeringMessage: true }),
        );
        assert.ok(handle, "Expected transcription reply to return a message handle.");
        handle.setInspect({
          kind: "text",
          text: inspectText,
        });
        await handle.update({ kind: "text", text: "Transcribed" });
      });

      await testbed.replayInboundCapture({
        type: "notify",
        messages: [
          whatsappTextMessage({
            chatId: INSPECT_CHAT_ID,
            text: "voice note placeholder",
            senderId: "vertical-user",
          }),
        ],
      });
      await waitForCondition(
        () => testbed.sentMessages.some((entry) => {
          const reaction = /** @type {{ react?: { text?: string } }} */ (entry.message).react;
          return reaction?.text === "👁";
        }),
        `Expected inspect marker reaction, got ${JSON.stringify(testbed.sentMessages)}`,
      );
      const transcriptionMessageId = findSentTextMessageId(
        testbed.sentMessages,
        (text) => text === "Transcribing audio...",
      );
      assert.equal(hasSentTextContaining(testbed.sentMessages, inspectText), false);
      assert.ok(
        hasSentTextContaining(testbed.sentMessages, "Transcribed"),
        `Expected compact transcription status, got ${JSON.stringify(testbed.sentMessages)}`,
      );

      await testbed.replayInboundCapture({
        type: "notify",
        messages: [
          whatsappReactionMessage({
            chatId: INSPECT_CHAT_ID,
            targetMessageId: transcriptionMessageId,
            reaction: "👁",
            senderLidJid: INSPECT_BOT_LID_JID,
            senderPhoneJid: INSPECT_BOT_PHONE_JID,
            id: "MSG-VERTICAL-BOT-TRANSCRIPTION-ECHO",
            targetParticipantJid: INSPECT_BOT_LID_JID,
          }),
        ],
      });
      assert.equal(hasSentTextContaining(testbed.sentMessages, inspectText), false);

      await testbed.replayInboundCapture({
        type: "notify",
        messages: [
          whatsappReactionMessage({
            chatId: INSPECT_CHAT_ID,
            targetMessageId: transcriptionMessageId,
            reaction: "👁",
            senderLidJid: INSPECT_USER_LID_JID,
            senderPhoneJid: INSPECT_USER_PHONE_JID,
            id: "MSG-VERTICAL-USER-TRANSCRIPTION-INSPECT",
            targetParticipantJid: INSPECT_BOT_LID_JID,
          }),
        ],
      });
      await waitForCondition(
        () => hasSentTextContaining(testbed.sentMessages, inspectText),
        `Expected user inspect reveal, got ${JSON.stringify(testbed.sentMessages)}`,
      );
    } finally {
      await testbed.stop();
    }
  });
});
