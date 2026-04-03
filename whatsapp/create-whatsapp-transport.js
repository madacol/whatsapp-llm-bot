import { appendFile } from "node:fs/promises";
import { createLogger } from "../logger.js";
import { sendEvent as sendOutboundEvent } from "./outbound/send-content.js";
import { adaptIncomingMessage } from "./inbound/chat-turn.js";
import { createWhatsAppConnectionSupervisor } from "./connection-supervisor.js";
import { classifyIncomingMessageEvent, normalizeReactionEvents } from "./inbound/message-event-classifier.js";
import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";

const log = createLogger("whatsapp");
const WHATSAPP_TEST_LOG_PATH = process.env.WHATSAPP_TEST_LOG_PATH ?? "/tmp/wh.log";
const WHATSAPP_TEST_TIMEOUT_MS = Number.parseInt(process.env.WHATSAPP_TEST_TIMEOUT_MS ?? "15000", 10);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is (...args: unknown[]) => unknown}
 */
function isFunction(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeSerialize(value) {
  /** @type {WeakSet<object>} */
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, innerValue) => {
    if (innerValue instanceof Error) {
      return serializeTransportError(innerValue);
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(innerValue)) {
      return {
        type: "Buffer",
        length: innerValue.length,
        preview: innerValue.toString("base64").slice(0, 64),
      };
    }
    if (typeof innerValue === "object" && innerValue !== null) {
      if (seen.has(innerValue)) {
        return "[Circular]";
      }
      seen.add(innerValue);
    }
    if (typeof innerValue === "bigint") {
      return String(innerValue);
    }
    return innerValue;
  }, 2);
}

/**
 * @param {import("@whiskeysockets/baileys").WASocket} sock
 * @returns {string[]}
 */
function getSocketMethodNames(sock) {
  /** @type {Set<string>} */
  const methods = new Set();
  /** @type {object | null} */
  let current = sock;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      const candidate = isRecord(current) ? current[name] : undefined;
      if (isFunction(candidate) && /^(community|group)/.test(name)) {
        methods.add(name);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return [...methods].sort();
}

/**
 * @param {{
 *   kind: string,
 *   phase?: "started" | "resolved" | "rejected" | "timeout",
 *   args?: Record<string, unknown>,
 *   result?: unknown,
 *   error?: unknown,
 *   availableMethods?: string[],
 *   meta?: Record<string, unknown>,
 * }} entry
 * @returns {Promise<void>}
 */
async function appendWhatsAppTestLog(entry) {
  const rendered = [
    `=== ${new Date().toISOString()} ${entry.kind} ===`,
    entry.phase ? `phase=${entry.phase}` : null,
    entry.availableMethods ? `methods=${safeSerialize(entry.availableMethods)}` : null,
    entry.args ? `args=${safeSerialize(entry.args)}` : null,
    entry.meta ? `meta=${safeSerialize(entry.meta)}` : null,
    entry.result !== undefined ? `result=${safeSerialize(entry.result)}` : null,
    entry.error !== undefined ? `error=${safeSerialize(serializeTransportError(entry.error))}` : null,
    "",
  ].filter((line) => line !== null).join("\n");
  await appendFile(WHATSAPP_TEST_LOG_PATH, `${rendered}\n`, "utf8");
}

/**
 * @param {string} kind
 * @param {number} timeoutMs
 * @returns {Error & {
 *   code: "WHATSAPP_TEST_TIMEOUT",
 *   kind: string,
 *   timeoutMs: number,
 * }}
 */
function createWhatsAppTestTimeoutError(kind, timeoutMs) {
  const error = new Error(`WhatsApp test "${kind}" timed out after ${timeoutMs}ms.`);
  error.name = "WhatsAppTestTimeoutError";
  /** @type {"WHATSAPP_TEST_TIMEOUT"} */
  const code = "WHATSAPP_TEST_TIMEOUT";
  return Object.assign(error, {
    code,
    kind,
    timeoutMs,
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} kind
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function withWhatsAppTestTimeout(promise, kind, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createWhatsAppTestTimeoutError(kind, timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * @param {{
 *   kind: string,
 *   args?: Record<string, unknown>,
 *   availableMethods: string[],
 *   execute: () => Promise<unknown>,
 *   timeoutMs?: number,
 *   appendLog?: (entry: {
 *     kind: string,
 *     phase?: "started" | "resolved" | "rejected" | "timeout",
 *     args?: Record<string, unknown>,
 *     result?: unknown,
 *     error?: unknown,
 *     availableMethods?: string[],
 *     meta?: Record<string, unknown>,
 *   }) => Promise<void>,
 * }} input
 * @returns {Promise<unknown>}
 */
export async function runLoggedWhatsAppTestOperation(input) {
  const timeoutMs = input.timeoutMs ?? WHATSAPP_TEST_TIMEOUT_MS;
  const appendLog = input.appendLog ?? appendWhatsAppTestLog;
  const startedAt = Date.now();

  await appendLog({
    kind: input.kind,
    phase: "started",
    args: input.args,
    availableMethods: input.availableMethods,
    meta: { timeoutMs },
  });

  try {
    const result = await withWhatsAppTestTimeout(input.execute(), input.kind, timeoutMs);
    await appendLog({
      kind: input.kind,
      phase: "resolved",
      args: input.args,
      availableMethods: input.availableMethods,
      result,
      meta: { durationMs: Date.now() - startedAt },
    });
    return result;
  } catch (error) {
    const phase = isRecord(error) && error.name === "WhatsAppTestTimeoutError" ? "timeout" : "rejected";
    await appendLog({
      kind: input.kind,
      phase,
      args: input.args,
      availableMethods: input.availableMethods,
      error,
      meta: { durationMs: Date.now() - startedAt },
    });
    throw error;
  }
}

/**
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
function serializeTransportError(error) {
  if (!isRecord(error)) {
    return { value: String(error) };
  }

  /** @type {Record<string, unknown>} */
  const serialized = {};

  for (const key of Object.getOwnPropertyNames(error)) {
    serialized[key] = error[key];
  }

  if (error instanceof Error) {
    serialized.name = error.name;
    serialized.message = error.message;
    serialized.stack = error.stack;
  }

  if ("data" in error) {
    serialized.data = error.data;
  }
  if ("output" in error && isRecord(error.output)) {
    serialized.output = error.output;
  }
  if ("statusCode" in error) {
    serialized.statusCode = error.statusCode;
  }

  return serialized;
}

/**
 * @typedef {{
 *   start: (onTurn: (turn: ChatTurn) => Promise<void>) => Promise<void>;
 *   stop: () => Promise<void>;
 *   sendText: (chatId: string, text: string) => Promise<void>;
 *   sendEvent?: (chatId: string, event: OutboundEvent) => Promise<MessageHandle | undefined>;
 *   createGroup: (subject: string, participants: string[]) => Promise<{ chatId: string, subject: string }>;
 *   promoteParticipants: (chatId: string, participants: string[]) => Promise<void>;
 *   renameGroup: (chatId: string, subject: string) => Promise<void>;
 *   setAnnouncementOnly: (chatId: string, enabled: boolean) => Promise<void>;
 *   runWhatsAppTest: (input: WhatsAppTestCommandInput) => Promise<WhatsAppTestResult>;
 * }} ChatTransport
 */

/**
 * Create a WhatsApp transport with a minimal app-facing surface.
 * @returns {Promise<ChatTransport>}
 */
export async function createWhatsAppTransport() {
  const confirmRuntime = createConfirmRuntime();
  const selectRuntime = createSelectRuntime();
  const reactionRuntime = createReactionRuntime();

  /** @type {(turn: ChatTurn) => Promise<void>} */
  let onTurn = async () => {};
  /** @type {import('@whiskeysockets/baileys').WASocket | null} */
  let currentSocket = null;

  /**
   * Clear all transport-owned runtime state and timers.
   * @returns {void}
   */
  function clearRuntimeState() {
    currentSocket = null;
    confirmRuntime.clear();
    selectRuntime.clear();
    reactionRuntime.clear();
  }

  const connectionSupervisor = await createWhatsAppConnectionSupervisor({
    onSocketReady: registerHandlers,
    onClearState: clearRuntimeState,
  });

  /**
   * Register socket handlers on the current socket instance.
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {() => Promise<void>} saveCreds
   * @returns {void}
   */
  function registerHandlers(sock, saveCreds) {
    currentSocket = sock;

    sock.ev.process(async (events) => {
      if (connectionSupervisor.isStopped()) {
        return;
      }

      if (events["connection.update"]) {
        if (events["connection.update"].connection === "close" && currentSocket === sock) {
          currentSocket = null;
        }
        await connectionSupervisor.handleConnectionUpdate(events["connection.update"], sock);
      }

      if (events["creds.update"]) {
        await saveCreds();
      }

      if (events["messages.upsert"]) {
        const { messages } = events["messages.upsert"];
        for (const message of messages) {
          if (message.key.fromMe) continue;

          const incomingEvent = classifyIncomingMessageEvent(message);
          switch (incomingEvent.kind) {
            case "ignore":
              continue;
            case "reaction":
              reactionRuntime.handleReactions(incomingEvent.reactions);
              continue;
            case "poll_update":
              try {
                const pollVoteEvent = await selectRuntime.resolvePollVoteMessage(incomingEvent.message, sock)
                  ?? await confirmRuntime.resolvePollVoteMessage(incomingEvent.message, sock);
                if (pollVoteEvent) {
                  if (!selectRuntime.handlePollVote(pollVoteEvent)) {
                    confirmRuntime.handlePollVote(pollVoteEvent);
                  }
                }
              } catch (error) {
                log.error("Error processing poll vote from upsert:", error);
              }
              continue;
            case "turn":
              await adaptIncomingMessage(
                incomingEvent.message,
                sock,
                onTurn,
                confirmRuntime,
                selectRuntime,
                reactionRuntime,
                undefined,
                { getSocket: () => currentSocket },
              );
              continue;
            default:
              continue;
          }
        }
      }

      if (events["messages.reaction"]) {
        const normalized = normalizeReactionEvents(events["messages.reaction"]);
        reactionRuntime.handleReactions(normalized);
      }
    });
  }

  return {
    async start(turnHandler) {
      onTurn = turnHandler;
      await connectionSupervisor.start();
    },

    async stop() {
      onTurn = async () => {};
      await connectionSupervisor.stop();
    },

    async sendText(chatId, text) {
      await connectionSupervisor.sendText(chatId, text);
    },

    async sendEvent(chatId, event) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      return sendOutboundEvent(sock, chatId, event, undefined, reactionRuntime);
    },

    async createGroup(subject, participants) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      let metadata;
      try {
        metadata = await sock.groupCreate(subject, participants);
      } catch (error) {
        log.error("WhatsApp groupCreate failed:", {
          subject,
          participants,
          error: serializeTransportError(error),
        });
        throw error;
      }
      if (typeof metadata.id !== "string") {
        throw new Error("Baileys groupCreate returned no group id.");
      }
      return {
        chatId: metadata.id,
        subject: typeof metadata.subject === "string" ? metadata.subject : subject,
      };
    },

    async promoteParticipants(chatId, participants) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      await sock.groupParticipantsUpdate(chatId, participants, "promote");
    },

    async renameGroup(chatId, subject) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      await sock.groupUpdateSubject(chatId, subject);
    },

    async setAnnouncementOnly(chatId, enabled) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      await sock.groupSettingUpdate(chatId, enabled ? "announcement" : "not_announcement");
    },

    async runWhatsAppTest(input) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      const availableMethods = getSocketMethodNames(sock);

      try {
        switch (input.kind) {
          case "methods": {
            await runLoggedWhatsAppTestOperation({
              kind: input.kind,
              args: input,
              availableMethods,
              execute: async () => ({ count: availableMethods.length, methods: availableMethods }),
            });
            return {
              summary: `Logged ${availableMethods.length} WhatsApp group/community methods to ${WHATSAPP_TEST_LOG_PATH}.`,
            };
          }
          case "community-create": {
            await runLoggedWhatsAppTestOperation({
              kind: input.kind,
              args: input,
              availableMethods,
              execute: async () => sock.communityCreate(input.subject, input.description),
            });
            return {
              summary: `Logged community creation result for \`${input.subject}\` to ${WHATSAPP_TEST_LOG_PATH}.`,
            };
          }
          case "community-create-group": {
            await runLoggedWhatsAppTestOperation({
              kind: input.kind,
              args: input,
              availableMethods,
              execute: async () => sock.communityCreateGroup(
                input.subject,
                input.participants,
                input.parentCommunityJid,
              ),
            });
            return {
              summary: `Logged subgroup creation result for \`${input.subject}\` to ${WHATSAPP_TEST_LOG_PATH}.`,
            };
          }
          case "community-link": {
            await runLoggedWhatsAppTestOperation({
              kind: input.kind,
              args: input,
              availableMethods,
              execute: async () => sock.communityLinkGroup(input.groupJid, input.parentCommunityJid),
            });
            return {
              summary: `Logged community link result for \`${input.groupJid}\` to ${WHATSAPP_TEST_LOG_PATH}.`,
            };
          }
          case "community-metadata": {
            await runLoggedWhatsAppTestOperation({
              kind: input.kind,
              args: input,
              availableMethods,
              execute: async () => sock.communityMetadata(input.jid),
            });
            return {
              summary: `Logged community metadata for \`${input.jid}\` to ${WHATSAPP_TEST_LOG_PATH}.`,
            };
          }
          case "community-linked": {
            await runLoggedWhatsAppTestOperation({
              kind: input.kind,
              args: input,
              availableMethods,
              execute: async () => sock.communityFetchLinkedGroups(input.jid),
            });
            return {
              summary: `Logged linked groups for \`${input.jid}\` to ${WHATSAPP_TEST_LOG_PATH}.`,
            };
          }
          case "smoke": {
            await runLoggedWhatsAppTestOperation({
              kind: input.kind,
              args: input,
              availableMethods,
              execute: async () => {
                const description = `madabot smoke test ${new Date().toISOString()}`;
                const communitySubject = `${input.baseSubject} Community`;
                const subgroupSubject = `${input.baseSubject} Workspace`;
                const community = await sock.communityCreate(communitySubject, description);
                if (!community?.id) {
                  throw new Error("communityCreate returned no community id.");
                }
                const metadata = await sock.communityMetadata(community.id);
                const subgroup = await sock.communityCreateGroup(
                  subgroupSubject,
                  input.participants,
                  community.id,
                );
                const linked = await sock.communityFetchLinkedGroups(community.id);
                return {
                  community,
                  metadata,
                  subgroup,
                  linked,
                };
              },
            });
            return {
              summary: `Logged WhatsApp smoke test artifacts for \`${input.baseSubject}\` to ${WHATSAPP_TEST_LOG_PATH}.`,
            };
          }
        }
      } catch (error) {
        await appendWhatsAppTestLog({
          kind: input.kind,
          args: input,
          availableMethods,
          error,
        });
        throw new Error(`WhatsApp test failed. Inspect ${WHATSAPP_TEST_LOG_PATH} for details.`);
      }
    },
  };
}

/**
 * Compatibility wrapper for the previous adapter API.
 * @param {(message: ChatTurn) => Promise<void>} onMessage
 * @returns {Promise<{ closeWhatsapp: () => Promise<void>, sendToChat: (chatId: string, text: string) => Promise<void> }>}
 */
export async function connectToWhatsApp(onMessage) {
  const transport = await createWhatsAppTransport();
  await transport.start(onMessage);
  return {
    closeWhatsapp: transport.stop,
    sendToChat: transport.sendText,
  };
}
