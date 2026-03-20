import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { normalizeChatId, rekeyHdDeferred, resolveHdDeferred, updateStoredHdRef } from "../../whatsapp-hd-media.js";
import { getMessageContent } from "./message-content.js";
import { sendBlocks } from "../outbound/send-content.js";
import { createReactionRuntime } from "../runtime/reaction-runtime.js";

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
 * Create the message-scoped TurnIO functions.
 * @param {{
 *   sock: import('@whiskeysockets/baileys').WASocket;
 *   chatId: string;
 *   message: BaileysMessage;
 *   senderIds: string[];
 *   isGroup: boolean;
 *   selectRuntime: import("../runtime/select-runtime.js").SelectRuntime;
 *   confirmRuntime: import("../runtime/confirm-runtime.js").ConfirmRuntime;
 *   reactionRuntime: import("../runtime/reaction-runtime.js").ReactionRuntime;
 * }} input
 * @returns {TurnIO}
 */
export function createTurnIo({
  sock,
  chatId,
  message,
  senderIds,
  isGroup,
  selectRuntime,
  confirmRuntime,
  reactionRuntime,
}) {
  return {
    send: (source, content) => sendBlocks(sock, chatId, source, content, undefined, reactionRuntime),
    reply: (source, content) => sendBlocks(sock, chatId, source, content, { quoted: message }, reactionRuntime),
    select: selectRuntime.createSelect(sock, chatId),
    confirm: confirmRuntime.createConfirm(sock, chatId),
    react: async (emoji) => {
      await sock.sendMessage(chatId, {
        react: { text: emoji, key: message.key },
      });
    },
    setWorking: async (working) => {
      await sock.sendPresenceUpdate(working ? "composing" : "paused", chatId);
    },
    getIsAdmin: async () => {
      if (!isGroup) return true;

      try {
        const groupMetadata = await sock.groupMetadata(chatId);
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
 * @returns {Promise<ChatTurn | null>}
 */
export async function buildIncomingTurn(
  baileysMessage,
  sock,
  confirmRuntime,
  selectRuntime,
  reactionRuntime = createReactionRuntime(),
  downloadFn = downloadMediaMessage,
) {
  if (baileysMessage.key.remoteJid === "status@broadcast") {
    return null;
  }

  const rawChatId = baileysMessage.key.remoteJid || "";
  const chatId = await normalizeChatId(rawChatId, sock);
  const { content, quotedSenderId, hdChild, hdParentMessageId } = await getMessageContent(baileysMessage, downloadFn);

  if (hdParentMessageId) {
    rekeyHdDeferred(rawChatId, chatId, hdParentMessageId);
  }

  if (hdChild) {
    resolveHdDeferred(chatId, hdChild.parentMessageId, hdChild.imageBlock);
    await updateStoredHdRef(chatId, hdChild.parentMessageId, hdChild.ref);
  }

  if (content.length === 0) {
    return null;
  }

  const key = /** @type {BaileysMessage["key"] & { participantLid?: string, participantPid?: string, senderLid?: string, senderPid?: string }} */ (baileysMessage.key);
  const senderIds = extractSenderIds(key);
  const isGroup = chatId.endsWith("@g.us");
  const selfIds = getSelfIds(sock);
  const addressedToBot = detectBotMention(content, selfIds);
  const repliedToBot = quotedSenderId ? selfIds.includes(quotedSenderId) : false;
  const normalizedContent = isGroup ? normalizeContent(content, selfIds) : content;
  const io = createTurnIo({
    sock,
    chatId,
    message: baileysMessage,
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
    senderName: baileysMessage.pushName || "",
    content: normalizedContent,
    timestamp: normalizeTimestamp(baileysMessage.messageTimestamp),
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
) {
  const turn = await buildIncomingTurn(
    baileysMessage,
    sock,
    confirmRuntime,
    selectRuntime,
    reactionRuntime,
    downloadFn,
  );

  if (!turn) {
    return;
  }

  await messageHandler(turn);
}
