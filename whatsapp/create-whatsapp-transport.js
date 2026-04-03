import { createLogger } from "../logger.js";
import { sendEvent as sendOutboundEvent } from "./outbound/send-content.js";
import { adaptIncomingMessage } from "./inbound/chat-turn.js";
import { createWhatsAppConnectionSupervisor } from "./connection-supervisor.js";
import { classifyIncomingMessageEvent, normalizeReactionEvents } from "./inbound/message-event-classifier.js";
import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";

const log = createLogger("whatsapp");

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
 *   linkExistingGroupToCommunity: (chatId: string, communityChatId: string) => Promise<void>;
 *   promoteParticipants: (chatId: string, participants: string[]) => Promise<void>;
 *   renameGroup: (chatId: string, subject: string) => Promise<void>;
 *   setAnnouncementOnly: (chatId: string, enabled: boolean) => Promise<void>;
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
