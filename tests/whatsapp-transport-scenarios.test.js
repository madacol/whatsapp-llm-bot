import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScenario, scenarioStep } from "./scenario-runner.js";
import { RAW_LID_POLL_FIXTURE } from "./poll-vote-fixtures.js";
import {
  rawLidPollIdentity,
  rawLidPollVoteMessage,
  replayWhatsAppInboundSmokeCapture,
  waitForPollSent,
  whatsappInspectableReplyModule,
  whatsappReactionMessage,
  whatsappTextMessage,
  whatsappSelectManyModule,
} from "./whatsapp-transport-scenario-modules.js";
import { appMessageEvent, assistantOutputEvent } from "../outbound-events.js";

const INSPECT_CHAT_ID = "120363042584279820@g.us";
const INSPECT_BOT_PHONE_JID = "393792375735@s.whatsapp.net";
const INSPECT_BOT_LID_JID = "147025689575646@lid";
const INSPECT_USER_LID_JID = "213597330374785@lid";
const INSPECT_USER_PHONE_JID = "555199900001@s.whatsapp.net";

/**
 * @param {import("./scenario-runner.js").ScenarioContext} ctx
 * @param {string} text
 * @returns {boolean}
 */
function hasSentTextContaining(ctx, text) {
  return ctx.sentMessages.some((entry) =>
    typeof entry.message.text === "string"
    && entry.message.text.includes(text));
}

/**
 * @param {import("./scenario-runner.js").ScenarioContext} ctx
 * @param {(text: string) => boolean} predicate
 * @returns {string}
 */
function findSentTextMessageId(ctx, predicate) {
  const entry = ctx.sentMessages.find((message) =>
    typeof message.message.text === "string"
    && predicate(message.message.text));
  assert.ok(entry, `Expected sent text message, got ${JSON.stringify(ctx.sentMessages)}`);
  return entry.id;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertStoredMessageId(value) {
  if (typeof value !== "string") {
    throw new Error(`Expected stored message id, got ${String(value)}`);
  }
  return value;
}

describe("WhatsApp transport scenarios", () => {
  it("proves the scenario runner with captured-shape raw LID selectMany poll votes", async () => {
    const selectedOption = "⚪ Show pinned tool status";
    const pollOptions = [
      { id: "pinned_tool_status", label: selectedOption },
      { id: "hide_thinking", label: "🟢 Hide thinking" },
      { id: "hide_file_changes", label: "🟢 Hide file changes" },
      { id: "hide_sub_agent_output", label: "🟢 Hide sub-agent output" },
      { id: "hide_all_extras", label: "⚪ Hide all extras" },
    ];

    await runScenario([
      whatsappSelectManyModule({
        identity: rawLidPollIdentity(RAW_LID_POLL_FIXTURE),
        pollMessageId: RAW_LID_POLL_FIXTURE.pollMsgId,
        prompt: "Choose which extra agent progress outputs are shown in chat.",
        options: pollOptions,
        deleteOnSelect: true,
        replyWithSelectionJson: true,
      }),

      replayWhatsAppInboundSmokeCapture({
        type: "notify",
        messages: [
          whatsappTextMessage({
            chatId: RAW_LID_POLL_FIXTURE.chatId,
            text: "choose",
            senderId: "poll-user",
          }),
        ],
      }),

      waitForPollSent(),

      replayWhatsAppInboundSmokeCapture({
        type: "notify",
        messages: [
          rawLidPollVoteMessage({
            fixture: RAW_LID_POLL_FIXTURE,
            id: "VOTE-LID-CAPTURED-SHAPE-1",
            selectedOption,
          }),
        ],
      }),

      async (ctx) => {
        assert.deepEqual(await ctx.result("selectMany"), {
          kind: "selected",
          ids: ["pinned_tool_status"],
        });

        assert.ok(
          ctx.sentMessages.some((entry) => {
            const message = /** @type {{ delete?: { id?: string } }} */ (entry.message);
            return message.delete?.id === RAW_LID_POLL_FIXTURE.pollMsgId;
          }),
          `Expected poll delete settlement, got ${JSON.stringify(ctx.sentMessages)}`,
        );
        assert.ok(
          ctx.sentMessages.some((entry) =>
            typeof entry.message.text === "string"
            && entry.message.text.includes("pinned_tool_status")),
          `Expected selected reply, got ${JSON.stringify(ctx.sentMessages)}`,
        );
      },
    ]);
  });

  it("keeps reasoning inspect hidden for bot marker echoes and reveals it for user eye reactions", async () => {
    await runScenario([
      whatsappInspectableReplyModule({
        botPhoneJid: INSPECT_BOT_PHONE_JID,
        replyEvent: assistantOutputEvent([{ type: "text", text: "Thinking..." }]),
        inspect: {
          kind: "reasoning",
          summary: "*Thinking*",
          text: "Inspectable reasoning should only show after a real user reaction.",
        },
      }),

      replayWhatsAppInboundSmokeCapture({
        type: "notify",
        messages: [
          whatsappTextMessage({
            chatId: INSPECT_CHAT_ID,
            text: "start reasoning",
            senderId: "scenario-user",
          }),
        ],
      }),

      scenarioStep("remember inspectable reasoning message", async (ctx) => {
        await ctx.waitFor(
          () => ctx.sentMessages.some((entry) => {
            const reaction = /** @type {{ react?: { text?: string } }} */ (entry.message).react;
            return reaction?.text === "👁";
          }),
          `Expected inspect marker reaction, got ${JSON.stringify(ctx.sentMessages)}`,
        );
        ctx.set("reasoning.messageId", findSentTextMessageId(ctx, (text) => text.endsWith("Thinking...")));
        assert.equal(hasSentTextContaining(ctx, "Inspectable reasoning should only show"), false);
      }),

      scenarioStep("replay bot inspect marker echo", async (ctx) => {
        await replayWhatsAppInboundSmokeCapture({
          type: "notify",
          messages: [
            whatsappReactionMessage({
              chatId: INSPECT_CHAT_ID,
              targetMessageId: assertStoredMessageId(ctx.get("reasoning.messageId")),
              reaction: "👁",
              senderLidJid: INSPECT_BOT_LID_JID,
              senderPhoneJid: INSPECT_BOT_PHONE_JID,
              id: "MSG-SCENARIO-BOT-INSPECT-ECHO",
              targetParticipantJid: INSPECT_BOT_LID_JID,
            }),
          ],
        })(ctx);
        assert.equal(hasSentTextContaining(ctx, "Inspectable reasoning should only show"), false);
      }),

      scenarioStep("replay real user inspect reaction", async (ctx) => {
        await replayWhatsAppInboundSmokeCapture({
          type: "notify",
          messages: [
            whatsappReactionMessage({
              chatId: INSPECT_CHAT_ID,
              targetMessageId: assertStoredMessageId(ctx.get("reasoning.messageId")),
              reaction: "👁",
              senderLidJid: INSPECT_USER_LID_JID,
              senderPhoneJid: INSPECT_USER_PHONE_JID,
              id: "MSG-SCENARIO-USER-INSPECT",
              targetParticipantJid: INSPECT_BOT_LID_JID,
            }),
          ],
        })(ctx);
        await ctx.waitFor(
          () => hasSentTextContaining(ctx, "Inspectable reasoning should only show"),
          `Expected user inspect reveal, got ${JSON.stringify(ctx.sentMessages)}`,
        );
      }),
    ], { name: "reasoning inspect marker echo" });
  });

  it("keeps audio transcription inspect hidden for bot marker echoes and reveals it for user eye reactions", async () => {
    await runScenario([
      whatsappInspectableReplyModule({
        botPhoneJid: INSPECT_BOT_PHONE_JID,
        replyEvent: appMessageEvent("plain", "Transcribing audio...", { replyToTriggeringMessage: true }),
        inspect: {
          kind: "text",
          text: "Audio transcript should only show after a real user reaction.",
        },
        update: { kind: "text", text: "Transcribed" },
      }),

      replayWhatsAppInboundSmokeCapture({
        type: "notify",
        messages: [
          whatsappTextMessage({
            chatId: INSPECT_CHAT_ID,
            text: "voice note placeholder",
            senderId: "scenario-user",
          }),
        ],
      }),

      scenarioStep("remember inspectable transcription message", async (ctx) => {
        await ctx.waitFor(
          () => ctx.sentMessages.some((entry) => {
            const reaction = /** @type {{ react?: { text?: string } }} */ (entry.message).react;
            return reaction?.text === "👁";
          }),
          `Expected inspect marker reaction, got ${JSON.stringify(ctx.sentMessages)}`,
        );
        ctx.set("transcription.messageId", findSentTextMessageId(ctx, (text) => text === "Transcribing audio..."));
        assert.equal(hasSentTextContaining(ctx, "Audio transcript should only show"), false);
        assert.ok(hasSentTextContaining(ctx, "Transcribed"), `Expected compact transcription status, got ${JSON.stringify(ctx.sentMessages)}`);
      }),

      scenarioStep("replay bot transcription inspect marker echo", async (ctx) => {
        await replayWhatsAppInboundSmokeCapture({
          type: "notify",
          messages: [
            whatsappReactionMessage({
              chatId: INSPECT_CHAT_ID,
              targetMessageId: assertStoredMessageId(ctx.get("transcription.messageId")),
              reaction: "👁",
              senderLidJid: INSPECT_BOT_LID_JID,
              senderPhoneJid: INSPECT_BOT_PHONE_JID,
              id: "MSG-SCENARIO-BOT-TRANSCRIPTION-ECHO",
              targetParticipantJid: INSPECT_BOT_LID_JID,
            }),
          ],
        })(ctx);
        assert.equal(hasSentTextContaining(ctx, "Audio transcript should only show"), false);
      }),

      scenarioStep("replay real user transcription inspect reaction", async (ctx) => {
        await replayWhatsAppInboundSmokeCapture({
          type: "notify",
          messages: [
            whatsappReactionMessage({
              chatId: INSPECT_CHAT_ID,
              targetMessageId: assertStoredMessageId(ctx.get("transcription.messageId")),
              reaction: "👁",
              senderLidJid: INSPECT_USER_LID_JID,
              senderPhoneJid: INSPECT_USER_PHONE_JID,
              id: "MSG-SCENARIO-USER-TRANSCRIPTION-INSPECT",
              targetParticipantJid: INSPECT_BOT_LID_JID,
            }),
          ],
        })(ctx);
        await ctx.waitFor(
          () => hasSentTextContaining(ctx, "Audio transcript should only show"),
          `Expected user inspect reveal, got ${JSON.stringify(ctx.sentMessages)}`,
        );
      }),
    ], { name: "audio transcription inspect marker echo" });
  });
});
