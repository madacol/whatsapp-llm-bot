import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { normalizeChatId } from "../../whatsapp-hd-media.js";
import { classifyIncomingMessageEvent } from "./message-event-classifier.js";
import { applyHdInboundLifecycle } from "./hd-image-lifecycle.js";
import { getMessageContent } from "./message-content.js";
import { sendEvent } from "../outbound/send-content.js";
import { createReactionRuntime } from "../runtime/reaction-runtime.js";

const DEFAULT_PRESENCE_LEASE_TTL_MS = 20_000;
const WHATSAPP_PRESENCE_PULSE_INTERVAL_MS = 8_000;

/**
 * Escape a string for safe use inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the bot's own IDs without the WhatsApp suffix.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {string[]}
 */
function getSelfIds(sock) {
  /** @type {string[]} */
  const ids = [];
  const id = sock.user?.id?.split(":")[0] || sock.user?.id;
  const lid = sock.user?.lid?.split(":")[0] || sock.user?.lid;
  if (id) ids.push(id);
  if (lid) ids.push(lid);
  return ids;
}

/**
 * Build the bot-mention prefix matcher for the current bot IDs.
 * @param {string[]} selfIds
 * @returns {RegExp | null}
 */
function createBotMentionPrefix(selfIds) {
  if (selfIds.length === 0) return null;
  return new RegExp(`^@(?:${selfIds.map(escapeRegExp).join("|")})\\s*`, "g");
}

/**
 * Detect whether any text content block addresses the bot.
 * @param {IncomingContentBlock[]} content
 * @param {string[]} selfIds
 * @returns {boolean}
 */
function detectBotMention(content, selfIds) {
  return content.some((block) => block.type === "text"
    && selfIds.some((selfId) => block.text.includes(`@${selfId}`)));
}

/**
 * Strip a leading bot mention from the first text block in group chats.
 * @param {IncomingContentBlock[]} content
 * @param {string[]} selfIds
 * @returns {IncomingContentBlock[]}
 */
function normalizeContent(content, selfIds) {
  const prefixPattern = createBotMentionPrefix(selfIds);
  if (!prefixPattern) return content;

  let firstTextSeen = false;
  return content.map((block) => {
    if (block.type !== "text" || firstTextSeen) {
      return block;
    }
    firstTextSeen = true;
    return {
      ...block,
      text: block.text.replace(prefixPattern, ""),
    };
  });
}

/**
 * Extract sender identifiers from a Baileys message key.
 * @param {BaileysMessage["key"] & { participantLid?: string, participantPid?: string, senderLid?: string, senderPid?: string }} key
 * @returns {string[]}
 */
function extractSenderIds(key) {
  /** @type {string[]} */
  const senderIds = [];
  senderIds.push(String(key.participant || key.remoteJid || "unknown"));
  senderIds.push(String(
    key.participantLid
    || key.participantPid
    || key.senderLid
    || key.senderPid
    || "unknown",
  ));

  return senderIds.map((senderId) => senderId.split("@")[0]);
}

/**
 * Convert a Baileys timestamp into a Date.
 * @param {BaileysMessage["messageTimestamp"]} value
 * @returns {Date}
 */
function normalizeTimestamp(value) {
  if (typeof value === "number") {
    return new Date(value * 1000);
  }
  if (!value) {
    return new Date();
  }
  return new Date(value.toNumber() * 1000);
}

/**
 * Resolve a human-readable chat title when one is available.
 * Groups use the subject; 1:1 chats fall back to the sender display name.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {boolean} isGroup
 * @param {string} senderName
 * @returns {Promise<string>}
 */
async function resolveChatName(sock, chatId, isGroup, senderName) {
  if (!isGroup) {
    return senderName;
  }
  if (typeof sock.groupMetadata !== "function") {
    return "";
  }
  try {
    const metadata = await sock.groupMetadata(chatId);
    return typeof metadata.subject === "string" ? metadata.subject : "";
  } catch {
    return "";
  }
}

/**
 * Build a per-chat presence lease controller.
 * The lease lifecycle is semantic: start, keepAlive, end.
 * The WhatsApp-specific composing pulse cadence is owned here.
 * @param {{
 *   sendPresenceUpdate: (presence: "composing" | "paused", chatId: string) => Promise<void>,
 *   chatId: string,
 *   defaultLeaseTtlMs?: number,
 *   pulseIntervalMs?: number,
 * }} input
 * @returns {{
 *   start: (ttlMs: number) => Promise<void>,
 *   keepAlive: (ttlMs?: number) => Promise<void>,
 *   afterOutboundMessage: () => Promise<void>,
 *   end: () => Promise<void>,
 * }}
 */
function createPresenceLeaseController({
  sendPresenceUpdate,
  chatId,
  defaultLeaseTtlMs = DEFAULT_PRESENCE_LEASE_TTL_MS,
  pulseIntervalMs = WHATSAPP_PRESENCE_PULSE_INTERVAL_MS,
}) {
  let active = false;
  let leaseTtlMs = defaultLeaseTtlMs;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let leaseTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pulseTimer = null;

  function clearLeaseTimer() {
    if (leaseTimer) {
      clearTimeout(leaseTimer);
      leaseTimer = null;
    }
  }

  function clearPulseTimer() {
    if (pulseTimer) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
  }

  function clearTimers() {
    clearLeaseTimer();
    clearPulseTimer();
  }

  /**
   * @returns {Promise<void>}
   */
  async function pauseAndRelease() {
    if (!active) {
      leaseTtlMs = defaultLeaseTtlMs;
      clearTimers();
      return;
    }
    active = false;
    leaseTtlMs = defaultLeaseTtlMs;
    clearTimers();
    await sendPresenceUpdate("paused", chatId);
  }

  function schedulePulse() {
    clearPulseTimer();
    if (!active) {
      return;
    }
    pulseTimer = setTimeout(() => {
      void (async () => {
        if (!active) {
          return;
        }
        try {
          await sendPresenceUpdate("composing", chatId);
        } catch {
          return;
        }
        schedulePulse();
      })();
    }, pulseIntervalMs);
  }

  /**
   * @param {number} ttlMs
   */
  function scheduleLeaseExpiry(ttlMs) {
    clearLeaseTimer();
    leaseTimer = setTimeout(() => {
      void pauseAndRelease().catch(() => {});
    }, ttlMs);
  }

  /**
   * @param {number} ttlMs
   * @returns {Promise<void>}
   */
  async function activateLease(ttlMs) {
    active = true;
    leaseTtlMs = ttlMs;
    clearTimers();
    await sendPresenceUpdate("composing", chatId);
    scheduleLeaseExpiry(ttlMs);
    schedulePulse();
  }

  return {
    start: async (ttlMs) => {
      await activateLease(ttlMs);
    },
    keepAlive: async (ttlMs) => {
      const nextTtlMs = ttlMs ?? leaseTtlMs;
      if (!active) {
        await activateLease(nextTtlMs);
        return;
      }
      leaseTtlMs = nextTtlMs;
      scheduleLeaseExpiry(nextTtlMs);
    },
    afterOutboundMessage: async () => {
      if (!active) {
        return;
      }
      await sendPresenceUpdate("composing", chatId);
      schedulePulse();
    },
    end: async () => {
      await pauseAndRelease();
    },
  };
}

/**
 * Create the message-scoped TurnIO functions.
 * @param {{
 *   sock: import('@whiskeysockets/baileys').WASocket;
 *   getSocket?: () => import('@whiskeysockets/baileys').WASocket | null;
 *   chatId: string;
 *   message: BaileysMessage;
 *   senderIds: string[];
 *   isGroup: boolean;
 *   selectRuntime: import("../runtime/select-runtime.js").SelectRuntime;
 *   confirmRuntime: import("../runtime/confirm-runtime.js").ConfirmRuntime;
 *   reactionRuntime: import("../runtime/reaction-runtime.js").ReactionRuntime;
 *   presenceConfig?: {
 *     defaultLeaseTtlMs?: number,
 *     pulseIntervalMs?: number,
 *   };
 * }} input
 * @returns {TurnIO}
 */
export function createTurnIo({
  sock,
  getSocket,
  chatId,
  message,
  senderIds,
  isGroup,
  selectRuntime,
  confirmRuntime,
  reactionRuntime,
  presenceConfig,
}) {
  /**
   * Resolve the current live socket for outbound operations.
   * @returns {import('@whiskeysockets/baileys').WASocket}
   */
  function requireSocket() {
    const activeSocket = getSocket ? getSocket() : sock;
    if (!activeSocket) {
      throw new Error("WhatsApp socket is not connected");
    }
    return activeSocket;
  }

  const presence = createPresenceLeaseController({
    sendPresenceUpdate: async (presenceState, targetChatId) => {
      await requireSocket().sendPresenceUpdate(presenceState, targetChatId);
    },
    chatId,
    defaultLeaseTtlMs: presenceConfig?.defaultLeaseTtlMs,
    pulseIntervalMs: presenceConfig?.pulseIntervalMs,
  });

  /**
   * Re-assert composing after visible outbound messages without delaying the
   * next harness step.
   * @returns {void}
   */
  function refreshComposingAfterOutboundMessage() {
    void presence.afterOutboundMessage().catch(() => {});
  }

  return {
    send: async (event) => {
      const handle = await sendEvent(requireSocket(), chatId, event, undefined, reactionRuntime);
      refreshComposingAfterOutboundMessage();
      return handle;
    },
    reply: async (event) => {
      const handle = await sendEvent(requireSocket(), chatId, event, undefined, reactionRuntime);
      refreshComposingAfterOutboundMessage();
      return handle;
    },
    select: selectRuntime.createSelect(getSocket ?? sock, chatId),
    confirm: confirmRuntime.createConfirm(getSocket ?? sock, chatId),
    react: async (emoji) => {
      await requireSocket().sendMessage(chatId, {
        react: { text: emoji, key: message.key },
      });
    },
    startPresence: async (ttlMs) => {
      await presence.start(ttlMs);
    },
    keepPresenceAlive: async (ttlMs) => {
      await presence.keepAlive(ttlMs);
    },
    endPresence: async () => {
      await presence.end();
    },
    getIsAdmin: async () => {
      if (!isGroup) return true;

      try {
        const groupMetadata = await requireSocket().groupMetadata(chatId);
        const participant = groupMetadata.participants.find((member) => senderIds.includes(member.id.split("@")[0]));
        return participant?.admin === "admin" || participant?.admin === "superadmin";
      } catch {
        return false;
      }
    },
  };
}

/**
 * Normalize a Baileys message into a ChatTurn.
 * Returns null when the message should be ignored by the app layer.
 * @param {BaileysMessage} baileysMessage
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import("../runtime/confirm-runtime.js").ConfirmRuntime} confirmRuntime
 * @param {import("../runtime/select-runtime.js").SelectRuntime} selectRuntime
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime} reactionRuntime
 * @param {(msg: BaileysMessage, type: "buffer", opts: {}) => Promise<Buffer>} [downloadFn]
 * @param {{ getSocket?: () => import('@whiskeysockets/baileys').WASocket | null } | undefined} [ioOptions]
 * @returns {Promise<ChatTurn | null>}
 */
export async function buildIncomingTurn(
  baileysMessage,
  sock,
  confirmRuntime,
  selectRuntime,
  reactionRuntime = createReactionRuntime(),
  downloadFn = downloadMediaMessage,
  ioOptions,
) {
  const incomingEvent = classifyIncomingMessageEvent(baileysMessage);
  if (incomingEvent.kind !== "turn") {
    return null;
  }
  const turnMessage = incomingEvent.message;

  const rawChatId = turnMessage.key.remoteJid || "";
  const chatId = await normalizeChatId(rawChatId, sock);
  const { content, quotedSenderId, hdLifecycle } = await getMessageContent(turnMessage, downloadFn);
  await applyHdInboundLifecycle({ rawChatId, chatId, lifecycle: hdLifecycle });

  if (content.length === 0) {
    return null;
  }

  const key = /** @type {BaileysMessage["key"] & { participantLid?: string, participantPid?: string, senderLid?: string, senderPid?: string }} */ (turnMessage.key);
  const senderIds = extractSenderIds(key);
  const isGroup = chatId.endsWith("@g.us");
  const selfIds = getSelfIds(sock);
  const addressedToBot = detectBotMention(content, selfIds);
  const repliedToBot = quotedSenderId ? selfIds.includes(quotedSenderId) : false;
  const normalizedContent = isGroup ? normalizeContent(content, selfIds) : content;
  const senderName = turnMessage.pushName || "";
  const chatName = await resolveChatName(sock, chatId, isGroup, senderName);
  const io = createTurnIo({
    sock,
    getSocket: ioOptions?.getSocket,
    chatId,
    message: turnMessage,
    senderIds,
    isGroup,
    selectRuntime,
    confirmRuntime,
    reactionRuntime,
  });

  /** @type {ChatTurn} */
  const turn = {
    chatId,
    senderIds,
    senderName: turnMessage.pushName || "",
    chatName,
    content: normalizedContent,
    timestamp: normalizeTimestamp(turnMessage.messageTimestamp),
    facts: {
      isGroup,
      addressedToBot,
      repliedToBot,
      ...(quotedSenderId && { quotedSenderId }),
    },
    io,
  };

  return turn;
}

/**
 * Adapt a Baileys message and invoke the app-level turn handler.
 * @param {BaileysMessage} baileysMessage
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {(message: ChatTurn) => Promise<void>} messageHandler
 * @param {import("../runtime/confirm-runtime.js").ConfirmRuntime} confirmRuntime
 * @param {import("../runtime/select-runtime.js").SelectRuntime} selectRuntime
 * @param {import("../runtime/reaction-runtime.js").ReactionRuntime} reactionRuntime
 * @param {(msg: BaileysMessage, type: "buffer", opts: {}) => Promise<Buffer>} [downloadFn]
 * @param {{ getSocket?: () => import('@whiskeysockets/baileys').WASocket | null } | undefined} [ioOptions]
 * @returns {Promise<void>}
 */
export async function adaptIncomingMessage(
  baileysMessage,
  sock,
  messageHandler,
  confirmRuntime,
  selectRuntime,
  reactionRuntime = createReactionRuntime(),
  downloadFn = downloadMediaMessage,
  ioOptions,
) {
  const turn = await buildIncomingTurn(
    baileysMessage,
    sock,
    confirmRuntime,
    selectRuntime,
    reactionRuntime,
    downloadFn,
    ioOptions,
  );

  if (!turn) {
    return;
  }

  await messageHandler(turn);
}
