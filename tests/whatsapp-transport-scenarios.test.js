import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScenario, scenarioStep } from "./scenario-runner.js";
import { createWhatsAppTransport } from "../whatsapp/create-whatsapp-transport.js";
import { RAW_LID_POLL_FIXTURE } from "./poll-vote-fixtures.js";
import {
  rawLidPollVoteMessage,
  replayWhatsAppInboundSmokeCapture,
  waitForPollSent,
  whatsappReactionMessage,
  whatsappTextMessage,
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

/**
 * @param {{
 *   botPhoneJid: string,
 *   botLidJid?: string,
 *   inboundCoalesceDelayMs?: number,
 *   pollMessageId?: string,
 *   pollEncKey?: Buffer,
 * }} input
 * @returns {import("./scenario-runner.js").ScenarioStep}
 */
function startWhatsAppTransport(input) {
  return scenarioStep("start WhatsApp transport", async (ctx) => {
    /** @type {{ current: ((events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => void | Promise<void>) | null }} */
    const processEventsRef = { current: null };
    /** @type {ChannelInput[]} */
    const turns = [];
    /** @type {WhatsAppTransportSocketPort} */
    const socket = {
      user: {
        id: input.botPhoneJid,
        ...(input.botLidJid ? { lid: input.botLidJid.replace("@lid", ":32@lid") } : {}),
      },
      ev: {
        /**
         * @param {(events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => void | Promise<void>} handler
         */
        process(handler) {
          processEventsRef.current = async (events) => {
            await handler(events);
          };
        },
      },
      sendMessage: async (targetChatId, message) => {
        const id = "poll" in message && input.pollMessageId
          ? input.pollMessageId
          : `sent-${ctx.sentMessages.length + 1}`;
        ctx.sentMessages.push({ id, chatId: targetChatId, message });
        if ("poll" in message) {
          if (!input.pollEncKey) {
            throw new Error("Expected poll encryption key for WhatsApp poll send.");
          }
          const poll = /** @type {{ poll?: { name?: unknown, values?: unknown[], selectableCount?: unknown } }} */ (message).poll;
          const values = poll?.values ?? [];
          return /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
            key: { id, remoteJid: targetChatId, fromMe: true },
            message: {
              messageContextInfo: {
                messageSecret: input.pollEncKey.toString("base64"),
              },
              pollCreationMessage: {
                name: typeof poll?.name === "string" ? poll.name : "",
                options: values
                  .filter((value) => typeof value === "string")
                  .map((value) => ({ optionName: value })),
                selectableOptionsCount: typeof poll?.selectableCount === "number"
                  ? poll.selectableCount
                  : values.length,
              },
            },
            participant: input.botPhoneJid,
          }));
        }
        return /** @type {BaileysMessage} */ ({ key: { id, remoteJid: targetChatId, fromMe: true } });
      },
      sendPresenceUpdate: async () => {},
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
        },
      },
    };
    let stopped = false;
    const transport = await createWhatsAppTransport({
      inboundCoalesceDelayMs: input.inboundCoalesceDelayMs ?? 5,
      createConnectionSupervisor: async ({ onSocketReady }) => ({
        start: async () => {
          stopped = false;
          onSocketReady(socket, async () => {});
        },
        stop: async () => {
          stopped = true;
        },
        sendText: async () => {},
        handleConnectionUpdate: async () => {},
        isStopped: () => stopped,
      }),
    });

    ctx.cleanup(async () => {
      await transport.stop();
    });

    await transport.start(async (turn) => {
      turns.push(turn);
    });

    const processEvents = processEventsRef.current;
    if (!processEvents) {
      throw new Error("Expected connection event processor to be registered.");
    }
    ctx.set("whatsapp.processEvents", processEvents);
    ctx.set("whatsapp.turns", turns);
    await processEvents({ "connection.update": { connection: "open" } });
    ctx.current = { seam: "whatsapp.transport", event: "connection.open" };
  });
}

/**
 * @param {import("./scenario-runner.js").ScenarioContext} ctx
 * @returns {ChannelInput[]}
 */
function getWhatsAppTurns(ctx) {
  const turns = ctx.get("whatsapp.turns");
  if (!Array.isArray(turns)) {
    throw new Error("Expected WhatsApp transport to record turns.");
  }
  return /** @type {ChannelInput[]} */ (turns);
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} failureMessage
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, failureMessage) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(failureMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
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
      startWhatsAppTransport({
        botPhoneJid: RAW_LID_POLL_FIXTURE.botPhoneJid,
        botLidJid: RAW_LID_POLL_FIXTURE.botLidJid,
        pollMessageId: RAW_LID_POLL_FIXTURE.pollMsgId,
        pollEncKey: RAW_LID_POLL_FIXTURE.pollEncKey,
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

      scenarioStep("app starts selectMany turn", async (ctx) => {
        await ctx.waitFor(
          () => getWhatsAppTurns(ctx).length > 0,
          `Expected WhatsApp transport turn, got ${JSON.stringify(getWhatsAppTurns(ctx))}`,
        );
        const turn = getWhatsAppTurns(ctx)[0];
        const selectMany = turn.io.selectMany;
        if (!selectMany) {
          throw new Error("Expected WhatsApp turn IO to provide selectMany.");
        }
        const selectionPromise = withTimeout(
          (async () => {
            const selection = await selectMany(
              "Choose which extra agent progress outputs are shown in chat.",
              pollOptions,
              { deleteOnSelect: true },
            );
            await turn.io.reply(assistantOutputEvent([{ type: "markdown", text: JSON.stringify(selection) }]));
            return selection;
          })(),
          5_000,
          "Expected selectMany result to settle.",
        );
        selectionPromise.catch(() => {});
        ctx.setResult("selectMany", selectionPromise);
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
      startWhatsAppTransport({
        botPhoneJid: INSPECT_BOT_PHONE_JID,
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

      scenarioStep("app replies with inspectable reasoning", async (ctx) => {
        await ctx.waitFor(
          () => getWhatsAppTurns(ctx).length > 0,
          `Expected WhatsApp transport turn, got ${JSON.stringify(getWhatsAppTurns(ctx))}`,
        );
        const turn = getWhatsAppTurns(ctx)[0];
        const handle = await turn.io.reply(assistantOutputEvent([{ type: "text", text: "Thinking..." }]));
        if (!handle) {
          throw new Error("Expected reasoning reply to return a message handle.");
        }
        handle.setInspect({
          kind: "reasoning",
          summary: "*Thinking*",
          text: "Inspectable reasoning should only show after a real user reaction.",
        });
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
      startWhatsAppTransport({
        botPhoneJid: INSPECT_BOT_PHONE_JID,
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

      scenarioStep("app replies with inspectable transcription status", async (ctx) => {
        await ctx.waitFor(
          () => getWhatsAppTurns(ctx).length > 0,
          `Expected WhatsApp transport turn, got ${JSON.stringify(getWhatsAppTurns(ctx))}`,
        );
        const turn = getWhatsAppTurns(ctx)[0];
        const handle = await turn.io.reply(
          appMessageEvent("plain", "Transcribing audio...", { replyToTriggeringMessage: true }),
        );
        if (!handle) {
          throw new Error("Expected transcription reply to return a message handle.");
        }
        handle.setInspect({
          kind: "text",
          text: "Audio transcript should only show after a real user reaction.",
        });
        await handle.update({ kind: "text", text: "Transcribed" });
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
