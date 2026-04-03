import { createLogger } from "../logger.js";
import { sendEvent as sendOutboundEvent } from "./outbound/send-content.js";
import { adaptIncomingMessage } from "./inbound/chat-turn.js";
import { createWhatsAppConnectionSupervisor } from "./connection-supervisor.js";
import { classifyIncomingMessageEvent, normalizeReactionEvents } from "./inbound/message-event-classifier.js";
import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";
import {
  generateMessageID,
  generateMessageIDV2,
  getBinaryNodeChild,
} from "@whiskeysockets/baileys";

const log = createLogger("whatsapp");

/**
 * @typedef {{
 *   query?: (
 *     node: import("@whiskeysockets/baileys").BinaryNode,
 *     timeoutMs?: number,
 *   ) => Promise<unknown>,
 *   communityCreate: (subject: string, description: string) => Promise<{ id?: string, subject?: string } | null>,
 *   communityFetchAllParticipating?: () => Promise<Record<string, { id?: string, subject?: string }>>,
 * }} CommunityCreateSocket
 *
 * @typedef {{
 *   query?: (
 *     node: import("@whiskeysockets/baileys").BinaryNode,
 *     timeoutMs?: number,
 *   ) => Promise<unknown>,
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
 * @param {{ query?: unknown }} sock
 * @returns {sock is { query: (
 *   node: import("@whiskeysockets/baileys").BinaryNode,
 *   timeoutMs?: number,
 * ) => Promise<unknown> }}
 */
function hasSocketQuery(sock) {
  return "query" in sock && isFunction(sock.query);
}

/**
 * @param {{ communityFetchAllParticipating?: unknown }} sock
 * @returns {sock is {
 *   communityFetchAllParticipating: () => Promise<Record<string, { id?: string, subject?: string }>>,
 * }}
 */
function hasCommunityFetchAllParticipating(sock) {
  return "communityFetchAllParticipating" in sock && isFunction(sock.communityFetchAllParticipating);
}

/**
 * @param {unknown} value
 * @returns {value is import("@whiskeysockets/baileys").BinaryNode}
 */
function isBinaryNode(value) {
  return isRecord(value) && typeof value.tag === "string" && isRecord(value.attrs);
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
 * @param {unknown} node
 * @returns {string | null}
 */
function extractCreatedGroupChatId(node) {
  if (!isBinaryNode(node)) {
    return null;
  }
  const groupNode = getBinaryNodeChild(node, "group");
  return normalizeGroupChatId(typeof groupNode?.attrs.id === "string" ? groupNode.attrs.id : undefined);
}

/**
 * @param {unknown} node
 * @returns {Record<string, unknown>}
 */
function serializeQueryResult(node) {
  if (!isRecord(node)) {
    return { value: String(node) };
  }
  return node;
}

/**
 * @param {string} subject
 * @param {string} description
 * @returns {import("@whiskeysockets/baileys").BinaryNode}
 */
function buildCommunityCreateQueryNode(subject, description) {
  const descriptionId = generateMessageID().substring(0, 12);
  return {
    tag: "iq",
    attrs: {
      type: "set",
      xmlns: "w:g2",
      to: "@g.us",
    },
    content: [{
      tag: "create",
      attrs: { subject },
      content: [
        {
          tag: "description",
          attrs: { id: descriptionId },
          content: [{
            tag: "body",
            attrs: {},
            content: Buffer.from(description || "", "utf-8"),
          }],
        },
        {
          tag: "parent",
          attrs: { default_membership_approval_mode: "request_required" },
        },
        {
          tag: "allow_non_admin_sub_group_creation",
          attrs: {},
        },
        {
          tag: "create_general_chat",
          attrs: {},
        },
      ],
    }],
  };
}

/**
 * @param {string} subject
 * @param {string[]} participants
 * @param {string} parentCommunityChatId
 * @returns {import("@whiskeysockets/baileys").BinaryNode}
 */
function buildCommunityCreateGroupQueryNode(subject, participants, parentCommunityChatId) {
  return {
    tag: "iq",
    attrs: {
      type: "set",
      xmlns: "w:g2",
      to: "@g.us",
    },
    content: [{
      tag: "create",
      attrs: {
        subject,
        key: generateMessageIDV2(),
      },
      content: [
        ...participants.map((jid) => ({
          tag: "participant",
          attrs: { jid },
        })),
        {
          tag: "linked_parent",
          attrs: { jid: parentCommunityChatId },
        },
      ],
    }],
  };
}

/**
 * @param {CommunityCreateSocket} sock
 * @param {string} subject
 * @returns {Promise<{ chatId: string, subject: string } | null>}
 */
async function findCreatedCommunityBySubject(sock, subject) {
  if (!hasCommunityFetchAllParticipating(sock)) {
    return null;
  }
  const communities = await sock.communityFetchAllParticipating();
  const candidates = Object.values(communities).filter((community) => community?.subject === subject);
  if (candidates.length !== 1) {
    return null;
  }
  const candidate = candidates[0];
  const chatId = normalizeGroupChatId(typeof candidate?.id === "string" ? candidate.id : undefined);
  if (!chatId) {
    return null;
  }
  return {
    chatId,
    subject: typeof candidate.subject === "string" ? candidate.subject : subject,
  };
}

/**
 * Create a community without blocking on Baileys' immediate metadata fetch.
 * @param {CommunityCreateSocket} sock
 * @param {string} subject
 * @param {string} description
 * @returns {Promise<{ chatId: string, subject: string }>}
 */
export async function executeCommunityCreate(sock, subject, description) {
  if (hasSocketQuery(sock)) {
    const result = await sock.query(buildCommunityCreateQueryNode(subject, description));
    const chatId = extractCreatedGroupChatId(result);
    if (chatId) {
      return { chatId, subject };
    }
    const fallback = await findCreatedCommunityBySubject(sock, subject);
    if (fallback) {
      log.warn("Recovered community id from participating communities after a create response without a direct group id.", {
        subject,
        recoveredChatId: fallback.chatId,
        response: serializeQueryResult(result),
      });
      return fallback;
    }
    log.error("WhatsApp community create returned an unexpected response.", {
      subject,
      description,
      response: serializeQueryResult(result),
    });
    throw new Error("WhatsApp community creation succeeded but returned no usable community id.");
  }

  const metadata = await sock.communityCreate(subject, description);
  if (!metadata || typeof metadata.id !== "string") {
    throw new Error("Baileys communityCreate returned no community id.");
  }
  return {
    chatId: metadata.id,
    subject: typeof metadata.subject === "string" ? metadata.subject : subject,
  };
}

/**
 * Create a subgroup inside a community without blocking on Baileys' metadata fetch.
 * @param {CommunityCreateGroupSocket} sock
 * @param {string} subject
 * @param {string[]} participants
 * @param {string} parentCommunityChatId
 * @returns {Promise<{ chatId: string, subject: string }>}
 */
export async function executeCommunityCreateGroup(sock, subject, participants, parentCommunityChatId) {
  if (hasSocketQuery(sock)) {
    const result = await sock.query(buildCommunityCreateGroupQueryNode(subject, participants, parentCommunityChatId));
    const chatId = extractCreatedGroupChatId(result);
    if (!chatId) {
      log.error("WhatsApp community subgroup create returned an unexpected response.", {
        subject,
        participants,
        parentCommunityChatId,
        response: serializeQueryResult(result),
      });
      throw new Error("WhatsApp community subgroup creation succeeded but returned no usable group id.");
    }
    return { chatId, subject };
  }

  const metadata = await sock.communityCreateGroup(subject, participants, parentCommunityChatId);
  if (!metadata || typeof metadata.id !== "string") {
    throw new Error("Baileys communityCreateGroup returned no group id.");
  }
  return {
    chatId: metadata.id,
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
 * @param {string} parentCommunityJid
 * @param {string} groupJid
 * @returns {import("@whiskeysockets/baileys").BinaryNode}
 */
function buildCommunityLinkQueryNode(parentCommunityJid, groupJid) {
  return {
    tag: "iq",
    attrs: {
      type: "set",
      xmlns: "w:g2",
      to: parentCommunityJid,
    },
    content: [{
      tag: "links",
      attrs: {},
      content: [{
        tag: "link",
        attrs: { link_type: "sub_group" },
        content: [{
          tag: "group",
          attrs: { jid: groupJid },
        }],
      }],
    }],
  };
}

/**
 * @param {{
 *   sock: import("@whiskeysockets/baileys").WASocket,
 *   groupJid: string,
 *   parentCommunityJid: string,
 * }} input
 * @returns {Promise<unknown>}
 */
async function linkGroupToCommunity({ sock, groupJid, parentCommunityJid }) {
  if (hasCommunityLinkGroup(sock)) {
    await sock.communityLinkGroup(groupJid, parentCommunityJid);
    return null;
  }
  if (!hasSocketQuery(sock)) {
    throw new Error("WhatsApp communityLinkGroup and socket query APIs are unavailable in this runtime.");
  }
  return sock.query(buildCommunityLinkQueryNode(parentCommunityJid, groupJid));
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
