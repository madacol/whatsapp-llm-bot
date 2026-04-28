import { createLogger } from "../logger.js";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { adaptIncomingMessage } from "./inbound/chat-turn.js";
import { createWhatsAppConnectionSupervisor } from "./connection-supervisor.js";
import { classifyIncomingMessageEvent, normalizeReactionEvents } from "./inbound/message-event-classifier.js";
import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";
import {
  flushQueuedWhatsAppOutbound,
  sendOrQueueWhatsAppEvent,
  sendOrQueueWhatsAppText,
} from "./outbound/persistent-queue.js";

const log = createLogger("whatsapp");
const WHATSAPP_UPSERT_DIAGNOSTIC_ENABLE_PATH = ".diagnostics/whatsapp-upsert-shape.enabled";
const WHATSAPP_UPSERT_DIAGNOSTIC_DEFAULT_PATH = ".diagnostics/whatsapp-upsert-shape.jsonl";

/**
 * @typedef {{
 *   communityCreate: (subject: string, description: string) => Promise<{ id?: string, subject?: string } | null>,
 * }} CommunityCreateSocket
 *
 * @typedef {{
 *   communityCreateGroup: (
 *     subject: string,
 *     participants: string[],
 *     parentCommunityChatId: string,
 *   ) => Promise<{ id?: string, subject?: string } | null>,
 * }} CommunityCreateGroupSocket
 *
 * @typedef {{
 *   groupMetadata: (chatId: string) => Promise<{ linkedParent?: string | null }>,
 * }} GroupMetadataSocket
 */

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
 * @returns {string | number | boolean | null | undefined}
 */
function toDiagnosticScalar(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `[bytes:${value.byteLength}]`;
  }
  if (typeof value === "object" && value !== null && "toString" in value && typeof value.toString === "function") {
    return value.toString();
  }
  return undefined;
}

/**
 * @param {import("@whiskeysockets/baileys").proto.IMessageKey | null | undefined} key
 * @returns {Record<string, unknown> | null}
 */
function summarizeMessageKey(key) {
  if (!key) {
    return null;
  }
  return {
    remoteJid: key.remoteJid ?? null,
    fromMe: key.fromMe ?? null,
    id: key.id ?? null,
    participant: key.participant ?? null,
  };
}

/**
 * @param {import("@whiskeysockets/baileys").proto.IMessageAssociation | null | undefined} association
 * @returns {Record<string, unknown> | null}
 */
function summarizeMessageAssociation(association) {
  if (!association) {
    return null;
  }
  return {
    associationType: association.associationType ?? null,
    parentMessageKey: summarizeMessageKey(association.parentMessageKey),
    messageIndex: association.messageIndex ?? null,
  };
}

/**
 * @param {import("@whiskeysockets/baileys").proto.IContextInfo | null | undefined} contextInfo
 * @returns {Record<string, unknown> | null}
 */
function summarizeContextInfo(contextInfo) {
  if (!contextInfo) {
    return null;
  }
  return {
    stanzaId: contextInfo.stanzaId ?? null,
    participant: contextInfo.participant ?? null,
    remoteJid: contextInfo.remoteJid ?? null,
    pairedMediaType: contextInfo.pairedMediaType ?? null,
    quotedMessageTypes: Object.keys(contextInfo.quotedMessage ?? {}),
  };
}

/**
 * Build a compact, JSON-safe diagnostic summary of the Baileys message fields
 * that define album/media grouping. This intentionally omits media bytes, media
 * keys, URLs, and direct paths.
 * @param {BaileysMessage} message
 * @returns {Record<string, unknown>}
 */
export function buildWhatsAppUpsertShapeDiagnostic(message) {
  const content = message.message;
  const associatedMessage = content?.associatedChildMessage?.message;
  return {
    receivedAt: new Date().toISOString(),
    key: summarizeMessageKey(message.key),
    messageTimestamp: toDiagnosticScalar(message.messageTimestamp),
    messageTypes: Object.keys(content ?? {}),
    albumMessage: content?.albumMessage
      ? {
          expectedImageCount: content.albumMessage.expectedImageCount ?? null,
          expectedVideoCount: content.albumMessage.expectedVideoCount ?? null,
          contextInfo: summarizeContextInfo(content.albumMessage.contextInfo),
        }
      : null,
    messageContextInfo: content?.messageContextInfo
      ? {
          hasMessageSecret: !!content.messageContextInfo.messageSecret,
          messageSecretLength: content.messageContextInfo.messageSecret?.length ?? null,
          messageAssociation: summarizeMessageAssociation(content.messageContextInfo.messageAssociation),
        }
      : null,
    imageMessage: content?.imageMessage
      ? {
          mimetype: content.imageMessage.mimetype ?? null,
          caption: content.imageMessage.caption ?? null,
          contextInfo: summarizeContextInfo(content.imageMessage.contextInfo),
        }
      : null,
    associatedChildMessageTypes: Object.keys(associatedMessage ?? {}),
    associatedChildMessageContextInfo: associatedMessage?.messageContextInfo
      ? {
          hasMessageSecret: !!associatedMessage.messageContextInfo.messageSecret,
          messageSecretLength: associatedMessage.messageContextInfo.messageSecret?.length ?? null,
          messageAssociation: summarizeMessageAssociation(associatedMessage.messageContextInfo.messageAssociation),
        }
      : null,
    associatedChildImageMessage: associatedMessage?.imageMessage
      ? {
          mimetype: associatedMessage.imageMessage.mimetype ?? null,
          caption: associatedMessage.imageMessage.caption ?? null,
          contextInfo: summarizeContextInfo(associatedMessage.imageMessage.contextInfo),
        }
      : null,
  };
}

/**
 * @returns {boolean}
 */
function isWhatsAppUpsertDiagnosticEnabled() {
  return process.env.WHATSAPP_UPSERT_DIAGNOSTIC === "1"
    || existsSync(WHATSAPP_UPSERT_DIAGNOSTIC_ENABLE_PATH);
}

/**
 * @param {BaileysMessage} message
 * @returns {void}
 */
function appendWhatsAppUpsertDiagnostic(message) {
  if (!isWhatsAppUpsertDiagnosticEnabled()) {
    return;
  }
  const targetPath = process.env.WHATSAPP_UPSERT_DIAGNOSTIC_PATH || WHATSAPP_UPSERT_DIAGNOSTIC_DEFAULT_PATH;
  mkdirSync(path.dirname(targetPath), { recursive: true });
  appendFileSync(targetPath, `${JSON.stringify(buildWhatsAppUpsertShapeDiagnostic(message))}\n`);
}

/**
 * @param {string | undefined} rawId
 * @returns {string | null}
 */
function normalizeGroupChatId(rawId) {
  if (typeof rawId !== "string" || !rawId.trim()) {
    return null;
  }
  return rawId.includes("@") ? rawId : `${rawId}@g.us`;
}

/**
 * Create a community via the Baileys API.
 * @param {CommunityCreateSocket} sock
 * @param {string} subject
 * @param {string} description
 * @returns {Promise<{ chatId: string, subject: string }>}
 */
export async function executeCommunityCreate(sock, subject, description) {
  const metadata = await sock.communityCreate(subject, description);
  if (!metadata) {
    log.error("Baileys communityCreate returned empty metadata.", {
      subject,
      description,
      metadata,
    });
    throw new Error("Baileys communityCreate returned no community id.");
  }
  const chatId = normalizeGroupChatId(metadata.id);
  if (!chatId) {
    log.error("Baileys communityCreate returned metadata without a usable id.", {
      subject,
      description,
      metadata,
      metadataKeys: Object.keys(metadata),
    });
    throw new Error("Baileys communityCreate returned no community id.");
  }
  return {
    chatId,
    subject: typeof metadata.subject === "string" ? metadata.subject : subject,
  };
}

/**
 * Create a subgroup inside a community via the Baileys API.
 * @param {CommunityCreateGroupSocket} sock
 * @param {string} subject
 * @param {string[]} participants
 * @param {string} parentCommunityChatId
 * @returns {Promise<{ chatId: string, subject: string }>}
 */
export async function executeCommunityCreateGroup(sock, subject, participants, parentCommunityChatId) {
  const metadata = await sock.communityCreateGroup(subject, participants, parentCommunityChatId);
  if (!metadata) {
    log.error("Baileys communityCreateGroup returned empty metadata.", {
      subject,
      participants,
      parentCommunityChatId,
      metadata,
    });
    throw new Error("Baileys communityCreateGroup returned no group id.");
  }
  const chatId = normalizeGroupChatId(metadata.id);
  if (!chatId) {
    log.error("Baileys communityCreateGroup returned metadata without a usable id.", {
      subject,
      participants,
      parentCommunityChatId,
      metadata,
      metadataKeys: Object.keys(metadata),
    });
    throw new Error("Baileys communityCreateGroup returned no group id.");
  }
  return {
    chatId,
    subject: typeof metadata.subject === "string" ? metadata.subject : subject,
  };
}

/**
 * Read a group's live linked parent via the Baileys metadata API.
 * @param {GroupMetadataSocket} sock
 * @param {string} chatId
 * @returns {Promise<string | null>}
 */
export async function executeGroupLinkedParentLookup(sock, chatId) {
  const metadata = await sock.groupMetadata(chatId);
  const linkedParent = normalizeGroupChatId(metadata.linkedParent ?? undefined);
  if (metadata.linkedParent != null && !linkedParent) {
    log.error("Baileys groupMetadata returned metadata without a usable linked parent.", {
      chatId,
      metadata,
    });
    throw new Error("Baileys groupMetadata returned an invalid linked parent.");
  }
  return linkedParent;
}

/**
 * @param {import("@whiskeysockets/baileys").WASocket} sock
 * @returns {boolean}
 */
function hasCommunityLinkGroup(sock) {
  return "communityLinkGroup" in sock && isFunction(sock.communityLinkGroup);
}

/**
 * @param {{
 *   sock: import("@whiskeysockets/baileys").WASocket,
 *   groupJid: string,
 *   parentCommunityJid: string,
 * }} input
 * @returns {Promise<void>}
 */
async function linkGroupToCommunity({ sock, groupJid, parentCommunityJid }) {
  if (!hasCommunityLinkGroup(sock)) {
    throw new Error("Baileys communityLinkGroup API is unavailable in this runtime.");
  }
  await sock.communityLinkGroup(groupJid, parentCommunityJid);
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
 *   createCommunity?: (subject: string, description: string) => Promise<{ chatId: string, subject: string }>;
 *   createCommunityGroup?: (
 *     subject: string,
 *     participants: string[],
 *     parentCommunityChatId: string,
 *   ) => Promise<{ chatId: string, subject: string }>;
 *   getGroupLinkedParent: (chatId: string) => Promise<string | null>;
 *   linkExistingGroupToCommunity: (chatId: string, communityChatId: string) => Promise<void>;
 *   promoteParticipants: (chatId: string, participants: string[]) => Promise<void>;
 *   renameGroup: (chatId: string, subject: string) => Promise<void>;
 *   setAnnouncementOnly: (chatId: string, enabled: boolean) => Promise<void>;
 * }} ChatTransport
 */

/**
 * @typedef {{
 *   createConnectionSupervisor?: typeof createWhatsAppConnectionSupervisor,
 *   outboundStore?: import("../store.js").Store,
 * }} CreateWhatsAppTransportOptions
 */

/**
 * Create a WhatsApp transport with a minimal app-facing surface.
 * @param {CreateWhatsAppTransportOptions} [options]
 * @returns {Promise<ChatTransport>}
 */
export async function createWhatsAppTransport(options = {}) {
  const confirmRuntime = createConfirmRuntime();
  const selectRuntime = createSelectRuntime();
  const reactionRuntime = createReactionRuntime();
  const createConnectionSupervisor = options.createConnectionSupervisor ?? createWhatsAppConnectionSupervisor;
  const outboundStore = options.outboundStore;

  /** @type {(turn: ChatTurn) => Promise<void>} */
  let onTurn = async () => {};
  /** @type {import('@whiskeysockets/baileys').WASocket | null} */
  let currentSocket = null;
  let started = false;
  let hasOpenConnection = false;
  /** @type {Promise<void> | null} */
  let flushQueuedPromise = null;

  /**
   * Clear all transport-owned runtime state and timers.
   * @returns {void}
   */
  function clearRuntimeState() {
    currentSocket = null;
    hasOpenConnection = false;
    confirmRuntime.clear();
    selectRuntime.clear();
    reactionRuntime.clear();
  }

  const connectionSupervisor = await createConnectionSupervisor({
    onSocketReady: registerHandlers,
    onClearState: clearRuntimeState,
  });

  /**
   * Replay any durable outbound messages once a live socket is available.
   * @returns {Promise<void>}
   */
  async function flushQueuedOutbound() {
    if (flushQueuedPromise) {
      return flushQueuedPromise;
    }

    flushQueuedPromise = flushQueuedWhatsAppOutbound({
      getSocket: () => currentSocket,
      reactionRuntime,
      ...(outboundStore ? { store: outboundStore } : {}),
    }).finally(() => {
      flushQueuedPromise = null;
    });

    return flushQueuedPromise;
  }

  /**
   * Register socket handlers on the current socket instance.
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {() => Promise<void>} saveCreds
   * @returns {void}
   */
  function registerHandlers(sock, saveCreds) {
    currentSocket = sock;
    hasOpenConnection = false;

    sock.ev.process(async (events) => {
      if (connectionSupervisor.isStopped()) {
        return;
      }

      if (events["connection.update"]) {
        if (events["connection.update"].connection === "close" && currentSocket === sock) {
          currentSocket = null;
          hasOpenConnection = false;
        }
        await connectionSupervisor.handleConnectionUpdate(events["connection.update"], sock);
        if (events["connection.update"].connection === "open" && currentSocket === sock) {
          hasOpenConnection = true;
          await flushQueuedOutbound();
        }
      }

      if (events["creds.update"]) {
        await saveCreds();
      }

      if (events["messages.upsert"]) {
        const { messages } = events["messages.upsert"];
        for (const message of messages) {
          if (message.key.fromMe) continue;
          appendWhatsAppUpsertDiagnostic(message);

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
      started = true;
      hasOpenConnection = false;
      await connectionSupervisor.start();
    },

    async stop() {
      started = false;
      hasOpenConnection = false;
      onTurn = async () => {};
      await connectionSupervisor.stop();
    },

    async sendText(chatId, text) {
      if (!started) {
        throw new Error("WhatsApp transport has not been started");
      }
      await sendOrQueueWhatsAppText({
        getSocket: () => hasOpenConnection ? currentSocket : null,
        chatId,
        text,
        ...(outboundStore ? { store: outboundStore } : {}),
      });
    },

    async sendEvent(chatId, event) {
      if (!started) {
        throw new Error("WhatsApp transport has not been started");
      }
      return sendOrQueueWhatsAppEvent({
        getSocket: () => hasOpenConnection ? currentSocket : null,
        chatId,
        event,
        reactionRuntime,
        ...(outboundStore ? { store: outboundStore } : {}),
      });
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

    async createCommunity(subject, description) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      try {
        return await executeCommunityCreate(sock, subject, description);
      } catch (error) {
        log.error("WhatsApp communityCreate failed:", {
          subject,
          description,
          error: serializeTransportError(error),
        });
        throw error;
      }
    },

    async createCommunityGroup(subject, participants, parentCommunityChatId) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      try {
        return await executeCommunityCreateGroup(sock, subject, participants, parentCommunityChatId);
      } catch (error) {
        log.error("WhatsApp communityCreateGroup failed:", {
          subject,
          participants,
          parentCommunityChatId,
          error: serializeTransportError(error),
        });
        throw error;
      }
    },

    async linkExistingGroupToCommunity(chatId, communityChatId) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      try {
        await linkGroupToCommunity({
          sock,
          groupJid: chatId,
          parentCommunityJid: communityChatId,
        });
      } catch (error) {
        log.error("WhatsApp communityLinkGroup failed:", {
          chatId,
          communityChatId,
          error: serializeTransportError(error),
        });
        throw error;
      }
    },

    async getGroupLinkedParent(chatId) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      try {
        return await executeGroupLinkedParentLookup(sock, chatId);
      } catch (error) {
        log.error("WhatsApp groupMetadata lookup failed:", {
          chatId,
          error: serializeTransportError(error),
        });
        throw error;
      }
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
