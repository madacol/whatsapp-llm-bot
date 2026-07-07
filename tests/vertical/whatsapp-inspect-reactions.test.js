import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { appMessageEvent, assistantOutputEvent } from "../../outbound-events.js";
import {
  createWhatsAppTransportTestbed,
  findSentTextMessageId,
  hasSentTextContaining,
  waitForCondition,
  whatsappGroupOnlyReactionMessage,
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
const REASONING_INSPECT_TEXT = "Inspectable reasoning should only show after a real user reaction.";
const TRANSCRIPTION_INSPECT_TEXT = "Audio transcript should only show after a real user reaction.";

/** @typedef {Awaited<ReturnType<typeof createWhatsAppTransportTestbed>>} WhatsAppTransportTestbed */

after(() => {
  if (originalTesting === undefined) {
    delete process.env.TESTING;
  } else {
    process.env.TESTING = originalTesting;
  }
});

/**
 * @returns {Promise<WhatsAppTransportTestbed>}
 */
function createInspectTestbed() {
  return createWhatsAppTransportTestbed({
    botPhoneJid: INSPECT_BOT_PHONE_JID,
    botLidJid: INSPECT_BOT_LID_JID,
  });
}

/**
 * @param {WhatsAppTransportTestbed} testbed
 * @param {string} text
 * @param {string} failureMessage
 * @param {number} [durationMs]
 * @returns {Promise<void>}
 */
async function assertNoSentTextContainingFor(testbed, text, failureMessage, durationMs = 75) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    assert.equal(
      hasSentTextContaining(testbed.sentMessages, text),
      false,
      `${failureMessage}: ${JSON.stringify(testbed.sentMessages)}`,
    );
    await delay(10);
  }
  assert.equal(
    hasSentTextContaining(testbed.sentMessages, text),
    false,
    `${failureMessage}: ${JSON.stringify(testbed.sentMessages)}`,
  );
}

/**
 * @param {WhatsAppTransportTestbed} testbed
 * @param {string} inboundText
 * @returns {Promise<{ handle: MessageHandle, messageId: string }>}
 */
async function startReasoningCompactMessage(testbed, inboundText) {
  /** @type {MessageHandle | undefined} */
  let handle;
  await testbed.start(async (turn) => {
    const sentHandle = await turn.io.reply(assistantOutputEvent([{ type: "text", text: "Thinking..." }]));
    assert.ok(sentHandle, "Expected reasoning reply to return a message handle.");
    handle = sentHandle;
  });

  await testbed.replayInboundCapture({
    type: "notify",
    messages: [
      whatsappTextMessage({
        chatId: INSPECT_CHAT_ID,
        text: inboundText,
        senderId: "vertical-user",
      }),
    ],
  });

  await waitForCondition(
    () => handle !== undefined,
    `Expected reasoning reply handle, got sent messages ${JSON.stringify(testbed.sentMessages)}`,
  );
  const sentHandle = handle;
  if (!sentHandle) {
    throw new Error("Expected reasoning reply to return a message handle.");
  }
  return {
    handle: sentHandle,
    messageId: findSentTextMessageId(testbed.sentMessages, (text) => text.endsWith("Thinking...")),
  };
}

/**
 * @param {WhatsAppTransportTestbed} testbed
 * @param {string} inboundText
 * @returns {Promise<{ handle: MessageHandle, messageId: string }>}
 */
async function startTranscriptionCompactMessage(testbed, inboundText) {
  /** @type {MessageHandle | undefined} */
  let handle;
  await testbed.start(async (turn) => {
    const sentHandle = await turn.io.reply(
      appMessageEvent("plain", "Transcribing audio...", { replyToTriggeringMessage: true }),
    );
    assert.ok(sentHandle, "Expected transcription reply to return a message handle.");
    handle = sentHandle;
  });

  await testbed.replayInboundCapture({
    type: "notify",
    messages: [
      whatsappTextMessage({
        chatId: INSPECT_CHAT_ID,
        text: inboundText,
        senderId: "vertical-user",
      }),
    ],
  });

  await waitForCondition(
    () => handle !== undefined,
    `Expected transcription reply handle, got sent messages ${JSON.stringify(testbed.sentMessages)}`,
  );
  const sentHandle = handle;
  if (!sentHandle) {
    throw new Error("Expected transcription reply to return a message handle.");
  }
  return {
    handle: sentHandle,
    messageId: findSentTextMessageId(testbed.sentMessages, (text) => text === "Transcribing audio..."),
  };
}

/**
 * @param {MessageHandle} handle
 * @returns {Promise<void>}
 */
async function finishReasoningDetails(handle) {
  handle.setInspect({
    kind: "reasoning",
    summary: "*Thinking*",
    text: REASONING_INSPECT_TEXT,
  });
  await handle.update({ kind: "text", text: "Thought" });
}

/**
 * @param {MessageHandle} handle
 * @returns {Promise<void>}
 */
async function finishTranscriptionDetails(handle) {
  handle.setInspect({
    kind: "text",
    text: TRANSCRIPTION_INSPECT_TEXT,
  });
  await handle.update({ kind: "text", text: "Transcribed" });
}

/**
 * @param {WhatsAppTransportTestbed} testbed
 * @param {string} messageId
 * @param {string} idPrefix
 * @returns {Promise<void>}
 */
async function replayNonUserEyeEvents(testbed, messageId, idPrefix) {
  await testbed.replayInboundCapture({
    type: "notify",
    messages: [
      whatsappReactionMessage({
        chatId: INSPECT_CHAT_ID,
        targetMessageId: messageId,
        reaction: "👁",
        senderLidJid: INSPECT_BOT_LID_JID,
        senderPhoneJid: INSPECT_BOT_PHONE_JID,
        id: `${idPrefix}-KNOWN-BOT`,
        targetParticipantJid: INSPECT_BOT_LID_JID,
      }),
      whatsappGroupOnlyReactionMessage({
        chatId: INSPECT_CHAT_ID,
        targetMessageId: messageId,
        reaction: "👁",
        id: `${idPrefix}-GROUP-ONLY`,
        targetParticipantJid: INSPECT_BOT_LID_JID,
      }),
    ],
  });
}

/**
 * @param {WhatsAppTransportTestbed} testbed
 * @param {string} messageId
 * @param {string} id
 * @returns {Promise<void>}
 */
async function replayUserEyeReaction(testbed, messageId, id) {
  await testbed.replayInboundCapture({
    type: "notify",
    messages: [
      whatsappReactionMessage({
        chatId: INSPECT_CHAT_ID,
        targetMessageId: messageId,
        reaction: "👁",
        senderLidJid: INSPECT_USER_LID_JID,
        senderPhoneJid: INSPECT_USER_PHONE_JID,
        id,
        targetParticipantJid: INSPECT_BOT_LID_JID,
      }),
    ],
  });
}

describe("WhatsApp inspect reactions", () => {
  it("keeps reasoning compact when details finish without user inspect", async () => {
    const testbed = await createInspectTestbed();
    try {
      const { handle } = await startReasoningCompactMessage(testbed, "reasoning without inspect");

      await finishReasoningDetails(handle);

      assert.ok(hasSentTextContaining(testbed.sentMessages, "Thought"));
      await assertNoSentTextContainingFor(
        testbed,
        REASONING_INSPECT_TEXT,
        "Expected reasoning detail to stay hidden without user inspect",
      );
    } finally {
      await testbed.stop();
    }
  });

  it("keeps reasoning compact when non-user eye events arrive before details finish", async () => {
    const testbed = await createInspectTestbed();
    try {
      const { handle, messageId } = await startReasoningCompactMessage(testbed, "reasoning non-user first");

      await replayNonUserEyeEvents(testbed, messageId, "MSG-VERTICAL-REASONING-NON-USER-FIRST");
      await finishReasoningDetails(handle);

      assert.ok(hasSentTextContaining(testbed.sentMessages, "Thought"));
      await assertNoSentTextContainingFor(
        testbed,
        REASONING_INSPECT_TEXT,
        "Expected reasoning detail to stay hidden after non-user eye events",
      );
    } finally {
      await testbed.stop();
    }
  });

  it("reveals reasoning when a user eye event arrives before details finish", async () => {
    const testbed = await createInspectTestbed();
    try {
      const { handle, messageId } = await startReasoningCompactMessage(testbed, "reasoning user first");

      await replayUserEyeReaction(testbed, messageId, "MSG-VERTICAL-REASONING-USER-FIRST");
      await assertNoSentTextContainingFor(
        testbed,
        REASONING_INSPECT_TEXT,
        "Expected reasoning detail to stay hidden before it exists",
      );
      await finishReasoningDetails(handle);

      await waitForCondition(
        () => hasSentTextContaining(testbed.sentMessages, REASONING_INSPECT_TEXT),
        `Expected user inspect reveal after reasoning finished, got ${JSON.stringify(testbed.sentMessages)}`,
      );
    } finally {
      await testbed.stop();
    }
  });

  it("reveals reasoning when a user eye event arrives after details finish", async () => {
    const testbed = await createInspectTestbed();
    try {
      const { handle, messageId } = await startReasoningCompactMessage(testbed, "reasoning detail first");

      await finishReasoningDetails(handle);
      await assertNoSentTextContainingFor(
        testbed,
        REASONING_INSPECT_TEXT,
        "Expected reasoning detail to stay hidden until user inspect",
      );
      await replayUserEyeReaction(testbed, messageId, "MSG-VERTICAL-REASONING-USER-AFTER-DETAIL");

      await waitForCondition(
        () => hasSentTextContaining(testbed.sentMessages, REASONING_INSPECT_TEXT),
        `Expected user inspect reveal, got ${JSON.stringify(testbed.sentMessages)}`,
      );
    } finally {
      await testbed.stop();
    }
  });

  it("keeps transcription compact when non-user eye events arrive before transcript detail finishes", async () => {
    const testbed = await createInspectTestbed();
    try {
      const { handle, messageId } = await startTranscriptionCompactMessage(testbed, "voice note placeholder");

      await replayNonUserEyeEvents(testbed, messageId, "MSG-VERTICAL-TRANSCRIPTION-NON-USER-FIRST");
      await finishTranscriptionDetails(handle);

      assert.ok(
        hasSentTextContaining(testbed.sentMessages, "Transcribed"),
        `Expected compact transcription status, got ${JSON.stringify(testbed.sentMessages)}`,
      );
      await assertNoSentTextContainingFor(
        testbed,
        TRANSCRIPTION_INSPECT_TEXT,
        "Expected transcription detail to stay hidden after non-user eye events",
      );

      await replayUserEyeReaction(testbed, messageId, "MSG-VERTICAL-TRANSCRIPTION-USER-AFTER-DETAIL");
      await waitForCondition(
        () => hasSentTextContaining(testbed.sentMessages, TRANSCRIPTION_INSPECT_TEXT),
        `Expected user inspect reveal for transcription, got ${JSON.stringify(testbed.sentMessages)}`,
      );
    } finally {
      await testbed.stop();
    }
  });
});
