import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeDiagnosticsState } from "../diagnostics-config.js";
import { createFixtureCapture } from "../diagnostics/capture.js";
import {
  captureWhatsAppMessageUpdateEvent,
  captureWhatsAppUpsertEvent,
  createWhatsAppTransport,
} from "../whatsapp/create-whatsapp-transport.js";
import { assistantOutputEvent } from "../outbound-events.js";
import { createEncryptedPollVote } from "./poll-vote-fixtures.js";
import { scenarioStep } from "./scenario-runner.js";

/**
 * @typedef {import("./scenario-runner.js").ScenarioContext} ScenarioContext
 * @typedef {import("./scenario-runner.js").ScenarioStep} ScenarioStep
 * @typedef {(events: Partial<import("@whiskeysockets/baileys").BaileysEventMap>) => void | Promise<void>} ProcessEvents
 *
 * @typedef {{
 *   botPhoneJid: string,
 *   botLidJid: string,
 *   pollEncKey: Buffer,
 * }} RawLidPollIdentity
 *
 * @typedef {{
 *   chatId: string,
 *   pollMsgId: string,
 *   botPhoneJid: string,
 *   botLidJid: string,
 *   voterLidJid: string,
 *   voterPhoneJid: string,
 *   pollEncKey: Buffer,
 *   encIv: Buffer,
 * }} RawLidPollFixture
 *
 * @typedef {{
 *   filePath: string,
 *   tempDir: string,
 * }} SmokeCaptureFile
 */

/**
 * @param {RawLidPollFixture} fixture
 * @returns {RawLidPollIdentity}
 */
export function rawLidPollIdentity(fixture) {
  return {
    botPhoneJid: fixture.botPhoneJid,
    botLidJid: fixture.botLidJid,
    pollEncKey: fixture.pollEncKey,
  };
}

/**
 * @param {{
 *   chatId: string,
 *   text: string,
 *   senderId: string,
 *   id?: string,
 *   senderName?: string,
 *   timestamp?: number,
 * }} input
 * @returns {import("@whiskeysockets/baileys").WAMessage}
 */
export function whatsappTextMessage({
  chatId,
  text,
  senderId,
  id = "MSG-SCENARIO-TEXT-1",
  senderName = "Scenario User",
  timestamp = 1782322700,
}) {
  return /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
    key: {
      remoteJid: chatId,
      fromMe: false,
      id,
      senderLid: `${senderId}-lid@lid`,
    },
    message: {
      conversation: text,
    },
    messageTimestamp: timestamp,
    pushName: senderName,
  }));
}

/**
 * @param {{
 *   chatId: string,
 *   targetMessageId: string,
 *   reaction: string,
 *   senderLidJid: string,
 *   senderPhoneJid?: string,
 *   id?: string,
 *   timestamp?: number,
 *   targetParticipantJid?: string,
 * }} input
 * @returns {import("@whiskeysockets/baileys").WAMessage}
 */
export function whatsappReactionMessage({
  chatId,
  targetMessageId,
  reaction,
  senderLidJid,
  senderPhoneJid,
  id = "MSG-SCENARIO-REACTION-1",
  timestamp = 1782322730,
  targetParticipantJid,
}) {
  return /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
    key: {
      remoteJid: chatId,
      fromMe: false,
      id,
      participant: senderLidJid,
      ...(senderPhoneJid ? { participantAlt: senderPhoneJid } : {}),
      addressingMode: "lid",
    },
    messageTimestamp: timestamp,
    message: {
      reactionMessage: {
        key: {
          remoteJid: chatId,
          fromMe: true,
          id: targetMessageId,
          ...(targetParticipantJid ? { participant: targetParticipantJid } : {}),
        },
        text: reaction,
        senderTimestampMs: timestamp * 1_000,
      },
    },
  }));
}

/**
 * Set up the WhatsApp transport and reply to the next inbound turn with one
 * inspectable message.
 * @param {{
 *   botPhoneJid: string,
 *   botLidJid?: string,
 *   replyEvent: OutboundEvent,
 *   inspect: MessageInspectState,
 *   update?: MessageHandleUpdate,
 *   inboundCoalesceDelayMs?: number,
 * }} input
 * @returns {ScenarioStep}
 */
export function whatsappInspectableReplyModule(input) {
  return scenarioStep("whatsappInspectableReplyModule", async (ctx) => {
    /** @type {{ current: ProcessEvents | null }} */
    const processEventsRef = { current: null };
    /** @type {WhatsAppTransportSocketPort} */
    const socket = {
      user: {
        id: input.botPhoneJid,
        ...(input.botLidJid ? { lid: input.botLidJid } : {}),
      },
      ev: {
        /**
         * @param {ProcessEvents} handler
         */
        process(handler) {
          processEventsRef.current = async (events) => {
            await handler(events);
          };
        },
      },
      /**
       * @param {string} targetChatId
       * @param {Record<string, unknown>} message
       * @returns {Promise<BaileysMessage>}
       */
      sendMessage: async (targetChatId, message) => {
        const id = `sent-${ctx.sentMessages.length + 1}`;
        ctx.sentMessages.push({ id, chatId: targetChatId, message });
        return /** @type {BaileysMessage} */ ({ key: { id, remoteJid: targetChatId, fromMe: true } });
      },
      sendPresenceUpdate: async () => {},
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
      const handle = await turn.io.reply(input.replyEvent);
      if (!handle) {
        throw new Error("Expected inspectable reply to return a message handle.");
      }
      handle.setInspect(input.inspect);
      if (input.update) {
        await handle.update(input.update);
      }
    });

    const registeredProcessEvents = processEventsRef.current;
    if (!registeredProcessEvents) {
      throw new Error("Expected connection event processor to be registered.");
    }

    ctx.set("whatsapp.processEvents", registeredProcessEvents);
    await registeredProcessEvents({ "connection.update": { connection: "open" } });
    ctx.current = { seam: "whatsapp.transport", event: "connection.open" };
  });
}

/**
 * @param {{
 *   fixture: RawLidPollFixture,
 *   selectedOption: string,
 *   id?: string,
 *   timestamp?: number,
 * }} input
 * @returns {import("@whiskeysockets/baileys").WAMessage}
 */
export function rawLidPollVoteMessage({
  fixture,
  selectedOption,
  id = "VOTE-LID-CAPTURED-SHAPE-1",
  timestamp = 1782322727,
}) {
  return /** @type {import("@whiskeysockets/baileys").WAMessage} */ (/** @type {unknown} */ ({
    key: {
      remoteJid: fixture.chatId,
      fromMe: false,
      id,
      participant: fixture.voterLidJid,
      participantAlt: fixture.voterPhoneJid,
      addressingMode: "lid",
    },
    messageTimestamp: timestamp,
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: {
          remoteJid: fixture.chatId,
          fromMe: true,
          id: fixture.pollMsgId,
          participant: fixture.botLidJid,
        },
        vote: createEncryptedPollVote({
          pollMsgId: fixture.pollMsgId,
          pollCreatorJid: fixture.botLidJid,
          voterJid: fixture.voterLidJid,
          pollEncKey: fixture.pollEncKey,
          encIv: fixture.encIv,
          selectedOption,
        }),
        senderTimestampMs: "1782322728220",
      },
    },
  }));
}

/**
 * Set up the WhatsApp transport and app handler for a selectMany turn.
 * @param {{
 *   identity: RawLidPollIdentity,
 *   pollMessageId: string,
 *   prompt: string,
 *   options: SelectOption[],
 *   deleteOnSelect?: boolean,
 *   replyWithSelectionJson?: boolean,
 *   resultName?: string,
 * }} input
 * @returns {ScenarioStep}
 */
export function whatsappSelectManyModule(input) {
  return scenarioStep("whatsappSelectManyModule", async (ctx) => {
    /** @type {{ current: ProcessEvents | null }} */
    const processEventsRef = { current: null };
    /** @type {(value: unknown) => void} */
    let resolveSelection = () => {};
    const selectionPromise = new Promise((resolve) => {
      resolveSelection = resolve;
    });
    const resultPromise = withTimeout(
      selectionPromise,
      5_000,
      `Expected ${input.resultName ?? "selectMany"} result to settle.`,
    );
    resultPromise.catch(() => {});
    ctx.setResult(input.resultName ?? "selectMany", resultPromise);

    /** @type {WhatsAppTransportSocketPort} */
    const socket = {
      user: {
        id: input.identity.botPhoneJid,
        lid: input.identity.botLidJid.replace("@lid", ":32@lid"),
      },
      ev: {
        /**
         * @param {ProcessEvents} handler
         */
        process(handler) {
          processEventsRef.current = async (events) => {
            await handler(events);
          };
        },
      },
      /**
       * @param {string} targetChatId
       * @param {Record<string, unknown>} message
       * @returns {Promise<BaileysMessage>}
       */
      sendMessage: async (targetChatId, message) => {
        const id = "poll" in message ? input.pollMessageId : `sent-${ctx.sentMessages.length + 1}`;
        ctx.sentMessages.push({ id, chatId: targetChatId, message });
        if ("poll" in message) {
          const values = /** @type {{ poll?: { values?: unknown[] } }} */ (message).poll?.values ?? [];
          return /** @type {BaileysMessage} */ (/** @type {unknown} */ ({
            key: { id, remoteJid: targetChatId, fromMe: true },
            message: {
              messageContextInfo: {
                messageSecret: input.identity.pollEncKey.toString("base64"),
              },
              pollCreationMessage: {
                name: input.prompt,
                options: values
                  .filter((value) => typeof value === "string")
                  .map((value) => ({ optionName: value })),
                selectableOptionsCount: values.length,
              },
            },
            participant: input.identity.botPhoneJid,
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
      inboundCoalesceDelayMs: 5,
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
      const selectMany = turn.io.selectMany;
      if (!selectMany) {
        throw new Error("Expected WhatsApp turn IO to provide selectMany.");
      }
      const selection = await selectMany(
        input.prompt,
        input.options,
        { deleteOnSelect: input.deleteOnSelect ?? false },
      );
      if (input.replyWithSelectionJson ?? false) {
        await turn.io.reply(assistantOutputEvent([{ type: "markdown", text: JSON.stringify(selection) }]));
      }
      resolveSelection(selection);
    });

    const registeredProcessEvents = processEventsRef.current;
    if (!registeredProcessEvents) {
      throw new Error("Expected connection event processor to be registered.");
    }

    ctx.set("whatsapp.processEvents", registeredProcessEvents);
    await registeredProcessEvents({ "connection.update": { connection: "open" } });
    ctx.current = { seam: "whatsapp.transport", event: "connection.open" };
  });
}

/**
 * Replay a full fixture-capture NDJSON file through the transport processor.
 * @param {string} filePath
 * @returns {ScenarioStep}
 */
export function replayWhatsAppCapture(filePath) {
  return scenarioStep("replayWhatsAppCapture", async (ctx) => {
    const processEvents = getProcessEvents(ctx);
    const records = await readNdjson(filePath);
    let replayed = 0;

    for (const record of records) {
      if (record.recordType !== "fixtureCapture.event") {
        continue;
      }
      ctx.current = record;
      if (record.seam === "whatsapp.inbound" && record.event === "messages.upsert") {
        await processEvents({
          "messages.upsert": /** @type {import("@whiskeysockets/baileys").BaileysEventMap["messages.upsert"]} */ (record.payload),
        });
        replayed += 1;
        continue;
      }
      if (record.seam === "whatsapp.inbound" && record.event === "messages.update") {
        await processEvents({
          "messages.update": /** @type {import("@whiskeysockets/baileys").BaileysEventMap["messages.update"]} */ (record.payload),
        });
        replayed += 1;
        continue;
      }
      throw new Error(`Unsupported capture event ${String(record.seam)}:${String(record.event)}.`);
    }

    if (replayed === 0) {
      throw new Error(`Expected at least one fixtureCapture.event in ${filePath}.`);
    }
  });
}

/**
 * Capture a WhatsApp inbound upsert through the fixture substrate, then replay it.
 * @param {unknown} payload
 * @returns {ScenarioStep}
 */
export function replayWhatsAppInboundSmokeCapture(payload) {
  return scenarioStep("replayWhatsAppInboundSmokeCapture", async (ctx) => {
    const capture = await writeWhatsAppInboundSmokeCapture({ event: "messages.upsert", payload });
    ctx.cleanup(async () => {
      await fs.rm(capture.tempDir, { recursive: true, force: true });
    });
    await replayWhatsAppCapture(capture.filePath)(ctx);
  });
}

/**
 * Wait until selectMany has sent a poll through the fake socket.
 * @param {{ timeoutMs?: number, resultName?: string }} [options]
 * @returns {ScenarioStep}
 */
export function waitForPollSent(options = {}) {
  return scenarioStep("waitForPollSent", async (ctx) => {
    await ctx.waitFor(
      () => ctx.sentMessages.some(isPollMessage),
      `Expected selectMany to send a poll, got ${JSON.stringify(ctx.sentMessages)}`,
      options.timeoutMs ?? 1_000,
    );
    const pollMessage = ctx.sentMessages.find(isPollMessage);
    ctx.setResult(options.resultName ?? "pollSent", pollMessage);
  });
}

/**
 * Write one WhatsApp inbound event through the real fixture capture substrate.
 * @param {{
 *   event: "messages.upsert" | "messages.update",
 *   payload: unknown,
 *   capturedAt?: Date,
 * }} input
 * @returns {Promise<SmokeCaptureFile>}
 */
export async function writeWhatsAppInboundSmokeCapture(input) {
  const capturedAt = input.capturedAt ?? new Date("2026-06-21T09:00:10.000Z");
  const enabledUntil = new Date(capturedAt.getTime() + 5 * 60_000).toISOString();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-inbound-capture-"));
  const baseDir = path.join(tempDir, "capture");
  const diagnostics = createRuntimeDiagnosticsState({
    configPath: path.join(tempDir, "logging.json"),
    env: {},
    reloadIntervalMs: 0,
  });
  await diagnostics.update({
    capture: {
      seams: {
        "whatsapp.inbound": {
          enabledUntil,
          fullRawUntil: enabledUntil,
          rotateMinutes: 1,
          retentionHours: 24,
          queueLimit: 10,
        },
      },
    },
  });
  const fixtureCapture = createFixtureCapture({
    diagnosticsState: diagnostics,
    baseDir,
    now: () => capturedAt,
  });

  if (input.event === "messages.upsert") {
    captureWhatsAppUpsertEvent(input.payload, { fixtureCapture });
  } else {
    captureWhatsAppMessageUpdateEvent(/** @type {unknown[]} */ (input.payload), { fixtureCapture });
  }

  await fixtureCapture.waitForIdle();
  const filePath = await findSingleCaptureFile(baseDir);
  return { filePath, tempDir };
}

/**
 * @param {ScenarioContext} ctx
 * @returns {ProcessEvents}
 */
function getProcessEvents(ctx) {
  const processEvents = ctx.get("whatsapp.processEvents");
  if (typeof processEvents !== "function") {
    throw new Error("WhatsApp transport module has not registered an event processor.");
  }
  return /** @type {ProcessEvents} */ (processEvents);
}

/**
 * @param {{ message: Record<string, unknown> }} entry
 * @returns {boolean}
 */
function isPollMessage(entry) {
  return "poll" in entry.message;
}

/**
 * @param {string} filePath
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function readNdjson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)));
}

/**
 * @param {string} baseDir
 * @returns {Promise<string>}
 */
async function findSingleCaptureFile(baseDir) {
  const entries = await fs.readdir(baseDir);
  const files = entries.filter((entry) => entry.endsWith(".ndjson"));
  if (files.length !== 1) {
    throw new Error(`Expected one capture file in ${baseDir}, got ${files.length}.`);
  }
  return path.join(baseDir, files[0]);
}

/**
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @param {string} failureMessage
 * @returns {Promise<unknown>}
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
