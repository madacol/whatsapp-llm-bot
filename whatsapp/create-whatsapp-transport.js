import { createLogger } from "../logger.js";
import { getDefaultFixtureCapture } from "../diagnostics/capture.js";
import { adaptIncomingMessages } from "./inbound/chat-turn.js";
import { createWhatsAppConnectionSupervisor } from "./connection-supervisor.js";
import { classifyIncomingMessageEvent, normalizeReactionEvents } from "./inbound/message-event-classifier.js";
import { createWhatsAppIngressDispatcher } from "./inbound/ingress-dispatcher.js";
import {
  createMessageUpdateIngressIdentity,
  createReactionIngressIdentity,
  createUpsertIngressKey,
  getMessageChatId,
  WHATSAPP_INGRESS_SOURCE_REACTION,
  WHATSAPP_INGRESS_SOURCE_UPDATE,
  WHATSAPP_INGRESS_SOURCE_UPSERT,
} from "./inbound/ingress-journal.js";
import { createConfirmRuntime } from "./runtime/confirm-runtime.js";
import { createReactionRuntime } from "./runtime/reaction-runtime.js";
import { createSelectRuntime } from "./runtime/select-runtime.js";
import {
  flushQueuedWhatsAppOutbound,
  sendOrQueueWhatsAppEvent,
  sendOrQueueWhatsAppText,
} from "./outbound/persistent-queue.js";
import { listQueuedWhatsAppOutbound } from "./outbound/queue-store.js";
import { editWhatsAppMessageByHandle } from "./outbound/send-content.js";
import { getOutboundQueueReplayDelayMs } from "../whatsapp-outbound-queue-config.js";

const log = createLogger("whatsapp");
const WHATSAPP_ALBUM_FLUSH_DELAY_MS = 1_200;
const WHATSAPP_TURN_COALESCE_DELAY_MS = 250;

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
 *   groupMetadata: (chatId: string) => Promise<{
 *     linkedParent?: string | null,
 *     participants?: Array<{ id?: string | null }>,
 *   }>,
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
 * @param {import("@whiskeysockets/baileys").proto.IMessageKey | null | undefined} key
 * @returns {string | null}
 */
function getAlbumBufferKey(key) {
  if (!key?.remoteJid || !key.id) {
    return null;
  }
  return `${key.remoteJid}:${key.id}`;
}

/**
 * @param {BaileysMessage} message
 * @returns {number | null}
 */
function getAlbumExpectedMediaCount(message) {
  const albumMessage = message.message?.albumMessage;
  if (!albumMessage) {
    return null;
  }
  const expectedImages = Number(albumMessage.expectedImageCount ?? 0);
  const expectedVideos = Number(albumMessage.expectedVideoCount ?? 0);
  const expectedTotal = expectedImages + expectedVideos;
  return expectedTotal > 0 ? expectedTotal : null;
}

/**
 * @param {BaileysMessage} message
 * @returns {string | null}
 */
function getAlbumParentBufferKey(message) {
  const association = message.message?.messageContextInfo?.messageAssociation;
  const parentKey = association?.parentMessageKey;
  return getAlbumBufferKey(parentKey);
}

/**
 * @param {BaileysMessage} message
 * @returns {boolean}
 */
function isAlbumMediaChild(message) {
  return !!getAlbumParentBufferKey(message)
    && !!(message.message?.imageMessage || message.message?.videoMessage || message.message?.ptvMessage);
}

/**
 * @param {{
 *   flushDelayMs?: number,
 *   handleAlbumMessages: (messages: BaileysMessage[]) => Promise<void>,
 * }} input
 * @returns {{
 *   handle: (message: BaileysMessage) => Promise<boolean>,
 *   flushAll: () => Promise<void>,
 * }}
 */
export function createWhatsAppAlbumCoordinator({ flushDelayMs = WHATSAPP_ALBUM_FLUSH_DELAY_MS, handleAlbumMessages }) {
  /** @type {Map<string, {
   *   expectedCount: number | null,
   *   children: BaileysMessage[],
   *   childIds: Set<string>,
   *   timer: ReturnType<typeof setTimeout> | null,
   *   flushing: Promise<void> | null,
   * }>} */
  const pendingAlbums = new Map();

  /**
   * @param {string} albumKey
   */
  function ensureAlbum(albumKey) {
    let album = pendingAlbums.get(albumKey);
    if (!album) {
      album = {
        expectedCount: null,
        children: [],
        childIds: new Set(),
        timer: null,
        flushing: null,
      };
      pendingAlbums.set(albumKey, album);
    }
    return album;
  }

  /**
   * @param {string} albumKey
   */
  function scheduleFlush(albumKey) {
    const album = pendingAlbums.get(albumKey);
    if (!album || album.timer) {
      return;
    }
    album.timer = setTimeout(() => {
      void flushAlbum(albumKey).catch((error) => {
        log.error("Error processing WhatsApp album:", error);
      });
    }, flushDelayMs);
  }

  /**
   * @param {string} albumKey
   * @returns {Promise<void>}
   */
  async function flushAlbum(albumKey) {
    const album = pendingAlbums.get(albumKey);
    if (!album) {
      return;
    }
    if (album.flushing) {
      await album.flushing;
      return;
    }
    if (album.timer) {
      clearTimeout(album.timer);
      album.timer = null;
    }
    pendingAlbums.delete(albumKey);

    album.flushing = (async () => {
      if (album.children.length > 0) {
        await handleAlbumMessages(album.children);
      }
    })();
    await album.flushing;
  }

  return {
    handle: async (message) => {
      const albumKey = getAlbumBufferKey(message.key);
      const expectedCount = getAlbumExpectedMediaCount(message);
      if (albumKey && expectedCount !== null) {
        const album = ensureAlbum(albumKey);
        album.expectedCount = expectedCount;
        if (album.children.length >= expectedCount) {
          await flushAlbum(albumKey);
        } else {
          scheduleFlush(albumKey);
        }
        return true;
      }

      if (!isAlbumMediaChild(message)) {
        return false;
      }

      const parentAlbumKey = /** @type {string} */ (getAlbumParentBufferKey(message));
      const album = ensureAlbum(parentAlbumKey);
      const childId = message.key.id || `${album.children.length}`;
      if (!album.childIds.has(childId)) {
        album.childIds.add(childId);
        album.children.push(message);
      }

      if (album.expectedCount !== null && album.children.length >= album.expectedCount) {
        await flushAlbum(parentAlbumKey);
      } else {
        scheduleFlush(parentAlbumKey);
      }
      return true;
    },
    flushAll: async () => {
      await Promise.all([...pendingAlbums.keys()].map((albumKey) => flushAlbum(albumKey)));
    },
  };
}

/**
 * @param {BaileysMessage} message
 * @returns {string}
 */
function getTurnCoalesceKey(message) {
  return message.key.remoteJid || "unknown-chat";
}

/**
 * Coalesce rapid same-chat turn messages before handing them to the app layer.
 * The quiet-window is deliberately transport-scoped: after the batch is flushed,
 * later messages are left for the normal active-run injection path.
 * @param {{
 *   flushDelayMs?: number,
 *   handleMessages: (messages: BaileysMessage[]) => Promise<void>,
 * }} input
 * @returns {{
 *   handle: (message: BaileysMessage) => Promise<void>,
 *   flushAll: () => Promise<void>,
 * }}
 */
export function createWhatsAppTurnCoalescer({ flushDelayMs = WHATSAPP_TURN_COALESCE_DELAY_MS, handleMessages }) {
  /** @type {Map<string, {
   *   messages: BaileysMessage[],
   *   waiters: Array<{ resolve: () => void, reject: (error: unknown) => void }>,
   *   timer: ReturnType<typeof setTimeout> | null,
   *   flushing: Promise<void> | null,
   * }>} */
  const pendingTurns = new Map();

  /**
   * @param {string} chatKey
   */
  function ensureBatch(chatKey) {
    let batch = pendingTurns.get(chatKey);
    if (!batch) {
      batch = {
        messages: [],
        waiters: [],
        timer: null,
        flushing: null,
      };
      pendingTurns.set(chatKey, batch);
    }
    return batch;
  }

  /**
   * @param {string} chatKey
   * @returns {Promise<void>}
   */
  async function flushBatch(chatKey) {
    const batch = pendingTurns.get(chatKey);
    if (!batch) {
      return;
    }
    if (batch.flushing) {
      await batch.flushing;
      return;
    }
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    pendingTurns.delete(chatKey);

    const messages = [...batch.messages];
    const waiters = [...batch.waiters];
    batch.messages.length = 0;
    batch.waiters.length = 0;
    if (messages.length === 0) {
      return;
    }

    batch.flushing = handleMessages(messages)
      .then(() => {
        for (const waiter of waiters) {
          waiter.resolve();
        }
      })
      .catch((error) => {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
        throw error;
      });
    await batch.flushing;
  }

  /**
   * @param {string} chatKey
   */
  function scheduleFlush(chatKey) {
    const batch = pendingTurns.get(chatKey);
    if (!batch) {
      return;
    }
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    batch.timer = setTimeout(() => {
      void flushBatch(chatKey).catch((error) => {
        log.error("Error processing coalesced WhatsApp turns:", error);
      });
    }, flushDelayMs);
  }

  return {
    handle: (message) => {
      const chatKey = getTurnCoalesceKey(message);
      const batch = ensureBatch(chatKey);
      batch.messages.push(message);
      const accepted = new Promise((resolve, reject) => {
        batch.waiters.push({
          resolve: () => resolve(undefined),
          reject,
        });
      });
      scheduleFlush(chatKey);
      return accepted;
    },
    flushAll: async () => {
      await Promise.all([...pendingTurns.keys()].map((chatKey) => flushBatch(chatKey)));
    },
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
 * @param {unknown} event
 * @param {{
 *   fixtureCapture?: import("../diagnostics/capture.js").FixtureCapture | null,
 * }} [options]
 * @returns {void}
 */
export function captureWhatsAppUpsertEvent(event, options = {}) {
  const fixtureCapture = options.fixtureCapture === undefined ? getDefaultFixtureCapture() : options.fixtureCapture;
  if (!fixtureCapture) {
    return;
  }
  fixtureCapture.capture({
    seam: "whatsapp.inbound",
    direction: "baileys_to_shell",
    event: "messages.upsert",
    payload: event,
  });
}

/**
 * @param {unknown[]} updates
 * @param {{ fixtureCapture?: import("../diagnostics/capture.js").FixtureCapture | null }} [options]
 * @returns {void}
 */
export function captureWhatsAppMessageUpdateEvent(updates, options = {}) {
  const fixtureCapture = options.fixtureCapture === undefined ? getDefaultFixtureCapture() : options.fixtureCapture;
  if (!fixtureCapture) {
    return;
  }
  fixtureCapture.capture({
    seam: "whatsapp.inbound",
    direction: "baileys_to_shell",
    event: "messages.update",
    payload: updates,
  });
}

/**
 * @param {import("./runtime/reaction-runtime.js").ReactionRuntimeObserverEvent} event
 * @param {{
 *   fixtureCapture?: import("../diagnostics/capture.js").FixtureCapture | null,
 * }} [options]
 * @returns {void}
 */
export function captureWhatsAppReactionRuntimeEvent(event, options = {}) {
  const fixtureCapture = options.fixtureCapture === undefined ? getDefaultFixtureCapture() : options.fixtureCapture;
  if (!fixtureCapture) {
    return;
  }
  fixtureCapture.capture({
    seam: "whatsapp.reaction",
    direction: "runtime",
    event: event.type,
    payload: event,
  });
}

/**
 * @param {unknown[]} reactions
 * @param {{ fixtureCapture?: import("../diagnostics/capture.js").FixtureCapture | null }} [options]
 * @returns {void}
 */
export function captureWhatsAppReactionEvent(reactions, options = {}) {
  const fixtureCapture = options.fixtureCapture === undefined ? getDefaultFixtureCapture() : options.fixtureCapture;
  if (!fixtureCapture) {
    return;
  }
  fixtureCapture.capture({
    seam: "whatsapp.reaction",
    direction: "baileys_to_shell",
    event: "messages.reaction",
    payload: reactions,
  });
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
 * Read a group's live participant JIDs via the Baileys metadata API.
 * @param {GroupMetadataSocket} sock
 * @param {string} chatId
 * @returns {Promise<string[]>}
 */
export async function executeGroupParticipantLookup(sock, chatId) {
  const metadata = await sock.groupMetadata(chatId);
  return [...new Set((metadata.participants ?? [])
    .map((participant) => typeof participant.id === "string" ? participant.id.trim() : "")
    .filter((participantId) => participantId.includes("@")))];
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
 *   editMessage?: (input: { transportHandleId: string, text: string }) => Promise<void>;
 *   createGroup: (subject: string, participants: string[]) => Promise<{ chatId: string, subject: string }>;
 *   createCommunity?: (subject: string, description: string) => Promise<{ chatId: string, subject: string }>;
 *   createCommunityGroup?: (
 *     subject: string,
 *     participants: string[],
 *     parentCommunityChatId: string,
 *   ) => Promise<{ chatId: string, subject: string }>;
 *   getGroupLinkedParent: (chatId: string) => Promise<string | null>;
 *   getGroupParticipants: (chatId: string) => Promise<string[]>;
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
 *   inboundCoalesceDelayMs?: number,
 *   inboundDispatchReady?: Promise<void>,
 *   onConnectionOpen?: (transport: {
 *     editMessage: (input: { transportHandleId: string, text: string }) => Promise<void>,
 *     sendText: (chatId: string, text: string) => Promise<void>,
 *     recoverQueuedMessage: (input: { chatId: string, queueId: number }) => MessageHandle | undefined,
 *     phase: "beforeQueueFlush" | "afterQueueFlush",
 *   }) => Promise<void>,
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
  const reactionRuntime = createReactionRuntime({ observer: captureWhatsAppReactionRuntimeEvent });
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
  /** @type {ReturnType<typeof setTimeout> | null} */
  let queuedOutboundRetryTimer = null;
  /** @type {Map<string, MessageHandle | undefined>} */
  const recentlyDeliveredQueuedHandles = new Map();

  /**
   * Clear all transport-owned runtime state and timers.
   * @returns {void}
   */
  function clearRuntimeState() {
    currentSocket = null;
    hasOpenConnection = false;
    if (queuedOutboundRetryTimer) {
      clearTimeout(queuedOutboundRetryTimer);
      queuedOutboundRetryTimer = null;
    }
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

    flushQueuedPromise = (async () => {
      const deliveredRows = await flushQueuedWhatsAppOutbound({
        getSocket: () => currentSocket,
        reactionRuntime,
        ...(outboundStore ? { store: outboundStore } : {}),
      });
      for (const row of deliveredRows) {
        recentlyDeliveredQueuedHandles.set(`${row.chatId}:${row.queueId}`, row.handle);
      }
    })().finally(() => {
      flushQueuedPromise = null;
    });

    return flushQueuedPromise;
  }

  /**
   * Queue replay normally runs on `connection.open`. Baileys can also throw a
   * recoverable send error while the socket still appears open; schedule a
   * same-connection replay so that durable rows do not wait for a future open.
   * @returns {void}
   */
  function scheduleQueuedOutboundRetry() {
    if (!hasOpenConnection || queuedOutboundRetryTimer) {
      return;
    }

    const delayMs = Math.max(25, getOutboundQueueReplayDelayMs());
    queuedOutboundRetryTimer = setTimeout(() => {
      queuedOutboundRetryTimer = null;
      const sock = currentSocket;
      if (!sock || !hasOpenConnection) {
        return;
      }
      void (async () => {
        if (!await waitForEventBufferToDrain(sock)) {
          return;
        }
        await flushQueuedOutbound();
        const remaining = outboundStore ? await listQueuedWhatsAppOutbound(outboundStore) : [];
        if (remaining.length > 0 && currentSocket === sock && hasOpenConnection) {
          scheduleQueuedOutboundRetry();
        }
      })().catch((error) => {
        log.error("Error retrying queued WhatsApp outbound work:", error);
      });
    }, delayMs);
  }

  /**
   * Resolve the socket only after Baileys reports the connection as open.
   * A registered socket can still be in initial sync, where outbound sends can
   * fail with "Precondition Required" / "Connection Closed".
   * @returns {import('@whiskeysockets/baileys').WASocket | null}
   */
  function getOpenSocket() {
    return hasOpenConnection ? currentSocket : null;
  }

  /**
   * Edit a previously sent outbound message once the connection is open.
   * @param {{ transportHandleId: string, text: string }} input
   * @returns {Promise<void>}
   */
  async function editMessage({ transportHandleId, text }) {
    const sock = getOpenSocket();
    if (!sock) {
      throw new Error("WhatsApp socket is not connected");
    }
    await editWhatsAppMessageByHandle(sock, transportHandleId, text, {
      ...(outboundStore ? { store: outboundStore } : {}),
    });
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function sendText(chatId, text) {
    if (!started) {
      throw new Error("WhatsApp transport has not been started");
    }
    const deliveryStatus = await sendOrQueueWhatsAppText({
      getSocket: getOpenSocket,
      chatId,
      text,
      ...(outboundStore ? { store: outboundStore } : {}),
    });
    if (deliveryStatus === "queued") {
      scheduleQueuedOutboundRetry();
    }
  }

  /**
   * Recover the sent handle produced when a durable outbound queue row flushed
   * before the current startup hook ran.
   * @param {{ chatId: string, queueId: number }} input
   * @returns {MessageHandle | undefined}
   */
  function recoverQueuedMessage({ chatId, queueId }) {
    return recentlyDeliveredQueuedHandles.get(`${chatId}:${queueId}`);
  }

  /**
   * @param {"beforeQueueFlush" | "afterQueueFlush"} phase
   * @returns {Promise<void>}
   */
  async function runConnectionOpenHook(phase) {
    if (!options.onConnectionOpen) {
      return;
    }
    try {
      await options.onConnectionOpen({ editMessage, sendText, recoverQueuedMessage, phase });
    } catch (error) {
      log.error("Error running WhatsApp connection-open hook:", error);
    }
  }

  /**
   * @param {unknown} value
   * @returns {value is { isBuffering: () => boolean }}
   */
  function hasBufferingState(value) {
    return typeof value === "object"
      && value !== null
      && "isBuffering" in value
      && typeof value.isBuffering === "function";
  }

  /**
   * Baileys emits `connection: open` before its initial-sync event buffer has
   * necessarily flushed. Outbound sends during that window can block inside
   * Baileys until the connection times out, delaying inbound delivery.
   * @param {import("@whiskeysockets/baileys").WASocket} sock
   * @returns {Promise<boolean>}
   */
  async function waitForEventBufferToDrain(sock) {
    const eventBuffer = sock.ev;
    if (!hasBufferingState(eventBuffer)) {
      return true;
    }

    while (currentSocket === sock && hasOpenConnection && eventBuffer.isBuffering()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return currentSocket === sock && hasOpenConnection;
  }

  /**
   * Replay durable outbound work after the Baileys open event without blocking
   * Baileys' own initial-sync event processor. Sends attempted during
   * AwaitingInitialSync can wait on Baileys internals for a long time; keeping
   * that wait out of sock.ev.process lets inbound buffering flush on schedule.
   * @param {import("@whiskeysockets/baileys").WASocket} sock
   * @returns {void}
   */
  function scheduleConnectionOpenWork(sock) {
    void (async () => {
      await runConnectionOpenHook("beforeQueueFlush");
      if (!await waitForEventBufferToDrain(sock)) {
        return;
      }
      await flushQueuedOutbound();
      await runConnectionOpenHook("afterQueueFlush");
    })().catch((error) => {
      log.error("Error running WhatsApp connection-open work:", error);
    });
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
    const turnCoalescer = createWhatsAppTurnCoalescer({
      flushDelayMs: options.inboundCoalesceDelayMs,
      handleMessages: async (messages) => {
        await adaptIncomingMessages(
          messages,
          sock,
          onTurn,
          confirmRuntime,
          selectRuntime,
          reactionRuntime,
          undefined,
          {
            getSocket: getOpenSocket,
            ...(outboundStore ? { outboundStore } : {}),
            scheduleQueuedOutboundRetry,
          },
        );
      },
    });
    const albumCoordinator = createWhatsAppAlbumCoordinator({
      handleAlbumMessages: async (albumMessages) => {
        await adaptIncomingMessages(
          albumMessages,
          sock,
          onTurn,
          confirmRuntime,
          selectRuntime,
          reactionRuntime,
          undefined,
          {
            getSocket: getOpenSocket,
            ...(outboundStore ? { outboundStore } : {}),
            scheduleQueuedOutboundRetry,
          },
        );
      },
    });

    /**
     * @param {BaileysMessage} message
     * @param {{ waitForBufferedTurnAcceptance?: boolean }} [options]
     * @returns {Promise<"done" | "ignored">}
     */
    async function processIncomingUpsertMessage(message, options = {}) {
      const waitForBufferedTurnAcceptance = options.waitForBufferedTurnAcceptance ?? true;
      if (message.key.fromMe) {
        return "ignored";
      }

      const incomingEvent = classifyIncomingMessageEvent(message);
      switch (incomingEvent.kind) {
        case "ignore":
          return "ignored";
        case "reaction":
          reactionRuntime.handleReactions(incomingEvent.reactions);
          return "done";
        case "poll_update": {
          const pollVoteEvent = await selectRuntime.resolvePollVoteMessage(incomingEvent.message, sock)
            ?? await confirmRuntime.resolvePollVoteMessage(incomingEvent.message, sock);
          if (pollVoteEvent) {
            if (!selectRuntime.handlePollVote(pollVoteEvent)) {
              confirmRuntime.handlePollVote(pollVoteEvent);
            }
          }
          return "done";
        }
        case "turn":
          if (await albumCoordinator.handle(incomingEvent.message)) {
            return "done";
          }
          {
            const accepted = turnCoalescer.handle(incomingEvent.message);
            if (waitForBufferedTurnAcceptance) {
              await accepted;
            }
          }
          return "done";
        default:
          return "ignored";
      }
    }

    /**
     * @param {import("@whiskeysockets/baileys").WAMessageUpdate} update
     * @returns {Promise<"done" | "ignored">}
     */
    async function processIncomingMessageUpdate(update) {
      if (!update.update.pollUpdates || update.update.pollUpdates.length === 0) {
        return "ignored";
      }

      const pollVoteEvent = await selectRuntime.resolvePollUpdate(update, sock)
        ?? await confirmRuntime.resolvePollUpdate(update, sock);
      if (!pollVoteEvent) {
        return "ignored";
      }

      if (!selectRuntime.handlePollVote(pollVoteEvent)) {
        confirmRuntime.handlePollVote(pollVoteEvent);
      }
      return "done";
    }

    /**
     * @param {unknown[]} reactions
     * @returns {"done" | "ignored"}
     */
    function processIncomingReactionEvents(reactions) {
      const normalized = normalizeReactionEvents(/** @type {Parameters<typeof normalizeReactionEvents>[0]} */ (reactions));
      if (normalized.length === 0) {
        return "ignored";
      }
      reactionRuntime.handleReactions(normalized);
      return "done";
    }

    const ingressDispatcher = outboundStore
      ? createWhatsAppIngressDispatcher({
          store: outboundStore,
          inboundDispatchReady: options.inboundDispatchReady,
          processUpsertMessage: processIncomingUpsertMessage,
          processMessageUpdate: processIncomingMessageUpdate,
          processReactionEvents: processIncomingReactionEvents,
          log,
        })
      : null;

    ingressDispatcher?.scheduleDrain();

    sock.ev.process(async (events) => {
      if (connectionSupervisor.isStopped()) {
        return;
      }

      if (events["connection.update"]) {
        if (events["connection.update"].connection === "close" && currentSocket === sock) {
          currentSocket = null;
          hasOpenConnection = false;
          await turnCoalescer.flushAll();
        }
        await connectionSupervisor.handleConnectionUpdate(events["connection.update"], sock);
        if (events["connection.update"].connection === "open" && currentSocket === sock) {
          hasOpenConnection = true;
          scheduleConnectionOpenWork(sock);
        }
      }

      if (events["creds.update"]) {
        await saveCreds();
      }

      if (events["messages.upsert"]) {
        captureWhatsAppUpsertEvent(events["messages.upsert"]);
        const { messages } = events["messages.upsert"];
        for (const message of messages) {
          if (outboundStore) {
            await outboundStore.enqueueWhatsAppIngressJournalEntry({
              ingressKey: createUpsertIngressKey(message),
              sourceEventType: WHATSAPP_INGRESS_SOURCE_UPSERT,
              chatId: getMessageChatId(message),
              payloadJson: { kind: WHATSAPP_INGRESS_SOURCE_UPSERT, message },
            });
            continue;
          }
          try {
            await processIncomingUpsertMessage(message, { waitForBufferedTurnAcceptance: false });
          } catch (error) {
            log.error("Error processing WhatsApp upsert:", error);
          }
        }
        ingressDispatcher?.scheduleDrain();
      }

      if (events["messages.update"]) {
        captureWhatsAppMessageUpdateEvent(events["messages.update"]);
        for (const update of events["messages.update"]) {
          if (!update.update.pollUpdates || update.update.pollUpdates.length === 0) {
            continue;
          }
          if (outboundStore) {
            const identity = createMessageUpdateIngressIdentity(update);
            await outboundStore.enqueueWhatsAppIngressJournalEntry({
              ingressKey: identity.ingressKey,
              sourceEventType: WHATSAPP_INGRESS_SOURCE_UPDATE,
              chatId: identity.chatId,
              payloadJson: { kind: WHATSAPP_INGRESS_SOURCE_UPDATE, update },
            });
            continue;
          }
          try {
            await processIncomingMessageUpdate(update);
          } catch (error) {
            log.error("Error processing WhatsApp message update:", error);
          }
        }
        ingressDispatcher?.scheduleDrain();
      }

      if (events["messages.reaction"]) {
        captureWhatsAppReactionEvent(events["messages.reaction"]);
        if (outboundStore) {
          if (!ingressDispatcher) {
            throw new Error("WhatsApp ingress dispatcher is unavailable.");
          }
          let index = 0;
          for (const reaction of events["messages.reaction"]) {
            const identity = createReactionIngressIdentity(reaction, index);
            await outboundStore.enqueueWhatsAppIngressJournalEntry({
              ingressKey: identity.ingressKey,
              sourceEventType: WHATSAPP_INGRESS_SOURCE_REACTION,
              chatId: identity.chatId,
              payloadJson: { kind: WHATSAPP_INGRESS_SOURCE_REACTION, reactions: [reaction] },
            });
            index += 1;
          }
          ingressDispatcher.scheduleDrain();
        } else {
          processIncomingReactionEvents(events["messages.reaction"]);
        }
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

    sendText,

    editMessage,

    async sendEvent(chatId, event) {
      if (!started) {
        throw new Error("WhatsApp transport has not been started");
      }
      const handle = await sendOrQueueWhatsAppEvent({
        getSocket: getOpenSocket,
        chatId,
        event,
        reactionRuntime,
        ...(outboundStore ? { store: outboundStore } : {}),
      });
      if (handle?.deliveryStatus === "queued") {
        scheduleQueuedOutboundRetry();
      }
      return handle;
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

    async getGroupParticipants(chatId) {
      const sock = currentSocket;
      if (!sock) {
        throw new Error("WhatsApp transport has not been started");
      }
      try {
        return await executeGroupParticipantLookup(sock, chatId);
      } catch (error) {
        log.error("WhatsApp groupMetadata participant lookup failed:", {
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
