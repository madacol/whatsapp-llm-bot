/**
 * WhatsApp Service - High-level abstraction over Baileys
 * Provides message-scoped APIs for easier migration to other WhatsApp clients
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  Browsers,
  fetchLatestWaWebVersion,
  isLidUser,
  jidNormalizedUser,
  decryptPollVote,
  getKeyAuthor,
  proto,
} from "@whiskeysockets/baileys";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { rm } from "node:fs/promises";
import { needsAuthReset, sendAlertEmail } from "./notifications.js";
import { renderBlocks } from "./message-renderer.js";
import { createLogger } from "./logger.js";

const log = createLogger("whatsapp");

/**
 * Stores sent poll creation messages keyed by message ID so we can
 * decode incoming poll votes via getAggregateVotesInPollMessage().
 * Entries are cleaned up after 10 minutes, with a hard cap to prevent
 * unbounded growth under heavy poll load.
 * @type {Map<string, import('@whiskeysockets/baileys').WAMessage>}
 */
const sentPolls = new Map();
const POLL_TTL_MS = 10 * 60 * 1000;
const MAX_SENT_POLLS = 200;

/**
 * Resolve the poll creation data from any Baileys poll message version (V1–V5).
 * @param {import('@whiskeysockets/baileys').WAMessage["message"]} msg
 * @returns {{ options: Array<{optionName?: string | null}> } | null}
 */
function getPollCreationData(msg) {
  const data = msg?.pollCreationMessage
    || msg?.pollCreationMessageV2
    || msg?.pollCreationMessageV3
    || msg?.pollCreationMessageV4
    || msg?.pollCreationMessageV5;
  if (!data || !("options" in data)) return null;
  return { options: data.options ?? [] };
}

/**
 * Decrypt a poll vote message and resolve the selected option names.
 * Uses the module-level `sentPolls` map to look up the original poll creation.
 * @param {import('@whiskeysockets/baileys').WAMessage} message - the incoming poll vote message
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {Promise<{ chatId: string, selectedOptions: string[] } | null>}
 */
async function decryptAndResolvePollVote(message, sock) {
  const pollUpdate = message.message?.pollUpdateMessage;
  if (!pollUpdate) return null;

  const creationKeyId = pollUpdate.pollCreationMessageKey?.id;
  log.debug(`Poll vote upsert: creationKeyId=${creationKeyId}`);
  if (!creationKeyId) return null;

  const pollCreation = sentPolls.get(creationKeyId);
  if (!pollCreation) {
    log.debug(`Poll creation not found in sentPolls for id=${creationKeyId}`);
    return null;
  }

  const encKey = pollCreation.message?.messageContextInfo?.messageSecret;
  if (!encKey || !pollUpdate.vote) {
    log.debug("Poll vote missing encKey or vote payload, skipping");
    return null;
  }

  // Decrypt the vote using Baileys' decryptPollVote.
  // The JIDs must match the addressing mode used for encryption.
  // When LID addressing is active, WhatsApp encrypts with LID JIDs,
  // so we must decrypt with LID JIDs too (not phone numbers).
  // getKeyAuthor() returns the Alt (opposite) format, so we bypass it
  // and use the primary JID fields directly.
  const voteJid = message.key.participant || message.key.remoteJid || "";
  const isLidVote = isLidUser(voteJid);

  /** @type {string} */
  let meId;
  /** @type {string} */
  let pollCreatorJid;
  /** @type {string} */
  let voterJid;

  if (isLidVote) {
    // LID addressing: use LID-format JIDs for decryption
    meId = sock.user?.lid
      ? jidNormalizedUser(sock.user.lid)
      : jidNormalizedUser(sock.user?.id ?? "");
    // Poll was created by us (fromMe), so creator = meId in LID format
    pollCreatorJid = pollCreation.key?.fromMe
      ? meId
      : (pollCreation.key?.participant || pollCreation.key?.remoteJid || "");
    // Voter is the person who voted, use primary (non-Alt) JID
    voterJid = message.key.fromMe
      ? meId
      : (message.key.participant || message.key.remoteJid || "");
  } else {
    // PN addressing: phone number JIDs
    meId = jidNormalizedUser(sock.user?.id ?? "");
    pollCreatorJid = getKeyAuthor(pollCreation.key, meId);
    voterJid = getKeyAuthor(message.key, meId);
  }

  log.debug(`Poll decrypt: isLid=${isLidVote}, meId=${meId}, creator=${pollCreatorJid}, voter=${voterJid}`);
  const decrypted = decryptPollVote(pollUpdate.vote, {
    pollEncKey: encKey,
    pollCreatorJid,
    pollMsgId: creationKeyId,
    voterJid,
  });
  log.debug(`Decrypted poll vote: ${JSON.stringify(decrypted)}`);

  // decrypted.selectedOptions contains SHA256 hashes of option names.
  // Match them against the poll creation options.
  const pollData = getPollCreationData(pollCreation.message);
  const options = pollData?.options ?? [];
  log.debug(`Poll options lookup: keys=${Object.keys(pollCreation.message || {}).filter(k => k.includes("poll"))}, optionCount=${options.length}`);

  const selectedHashes = (decrypted.selectedOptions ?? []).map(
    (/** @type {Uint8Array} */ h) => Buffer.from(h).toString("hex"),
  );

  // Hash each option name and match
  const selected = options
    .filter(opt => {
      if (!opt.optionName) return false;
      const hash = createHash("sha256").update(opt.optionName).digest("hex");
      return selectedHashes.includes(hash);
    })
    .map(opt => opt.optionName ?? "");

  log.debug(`Poll vote decoded: selected=[${selected.join(",")}]`);
  if (selected.length === 0) return null;

  let chatId = message.key.remoteJid || pollCreation.key?.remoteJid || "";
  if (isLidUser(chatId)) {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(chatId);
    if (pn) chatId = jidNormalizedUser(pn);
  }

  return { chatId, selectedOptions: selected };
}

const AUTH_DIR = "./auth_info_baileys";
const QR_TIMEOUT_MS = 5 * 60 * 1000;

/** @type {ReturnType<typeof setTimeout> | null} */
let qrExitTimer = null;
let sessionResetInProgress = false;

/**
 * Extract the bot's own IDs (without the @s.whatsapp.net suffix) from the socket user info.
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
 * Extract contextInfo from any Baileys message type that carries it.
 * @param {BaileysMessage['message']} msg
 */
function getContextInfo(msg) {
  return msg?.extendedTextMessage?.contextInfo
    || msg?.imageMessage?.contextInfo
    || msg?.videoMessage?.contextInfo
    || msg?.documentMessage?.contextInfo
    || msg?.audioMessage?.contextInfo
    || msg?.ptvMessage?.contextInfo
    || msg?.stickerMessage?.contextInfo;
}

/**
 * @typedef {{
 *   onSent?: (msgKey: { id: string; remoteJid: string }) => Promise<void>;
 *   onResolved?: (msgKey: { id: string; remoteJid: string }, confirmed: boolean) => Promise<void>;
 * }} ConfirmHooks
 */

/**
 * @typedef {{
 *   resolve: (value: boolean) => void;
 *   rawKey: import('@whiskeysockets/baileys').WAMessageKey;
 *   msgKey: { id: string; remoteJid: string };
 *   chatId: string;
 *   hooks?: ConfirmHooks;
 *   timer: ReturnType<typeof setTimeout>;
 * }} PendingConfirm
 */

/** Safety-net timeout: auto-reject after 30 minutes of no reaction. */
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @typedef {{
 *   handleReactions: (reactions: Array<{ key: { id: string; remoteJid: string }; reaction: { text: string } }>, sock: import('@whiskeysockets/baileys').WASocket) => void;
 *   createConfirm: (sock: import('@whiskeysockets/baileys').WASocket, chatId: string) => (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
 *   readonly size: number;
 *   clear: () => void;
 * }} ConfirmRegistry
 */

/**
 * Create a registry that routes reactions to pending confirmations.
 * Uses a single Map instead of per-confirm event listeners, so there is
 * exactly zero risk of listener accumulation.
 *
 * Lifecycle: create once per connection; on reconnect the same registry
 * is reused (message IDs are globally unique).
 * @returns {ConfirmRegistry}
 */
export function createConfirmRegistry() {
  /** @type {Map<string, PendingConfirm>} */
  const pending = new Map();

  return {
    /**
     * Route incoming reactions to any matching pending confirmation.
     * Called once per batch from the socket-level event handler.
     * @param {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string } }>} reactions
     * @param {import('@whiskeysockets/baileys').WASocket} sock
     */
    handleReactions(reactions, sock) {
      for (const { key, reaction } of reactions) {
        const entry = pending.get(key.id);
        if (!entry) continue;

        /** @type {boolean | null} */
        let confirmed = null;
        /** @type {string} */
        let emoji = "";

        if (reaction.text?.startsWith("👍")) {
          confirmed = true;
          emoji = "✅";
        } else if (reaction.text?.startsWith("👎")) {
          confirmed = false;
          emoji = "❌";
        }

        if (confirmed === null) continue;

        clearTimeout(entry.timer);
        pending.delete(key.id);
        sock.sendMessage(entry.chatId, { react: { text: emoji, key: entry.rawKey } });
        entry.hooks?.onResolved?.(entry.msgKey, confirmed);
        entry.resolve(confirmed);
      }
    },

    /**
     * Create a confirm function scoped to a chat.
     * @param {import('@whiskeysockets/baileys').WASocket} sock
     * @param {string} chatId
     * @returns {(message: string, hooks?: ConfirmHooks) => Promise<boolean>}
     */
    createConfirm(sock, chatId) {
      return async (message, hooks) => {
        const sentMsg = await sock.sendMessage(chatId, { text: message });
        if (!sentMsg) return false;

        const rawKey = sentMsg.key;
        if (!rawKey.id || !rawKey.remoteJid) return false;

        /** @type {{ id: string; remoteJid: string }} */
        const msgKey = { id: rawKey.id, remoteJid: rawKey.remoteJid };

        // React with hourglass to indicate waiting
        sock.sendMessage(chatId, {
          react: { text: "⏳", key: rawKey },
        });

        if (hooks?.onSent) {
          await hooks.onSent(msgKey);
        }

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(msgKey.id);
            sock.sendMessage(chatId, { react: { text: "⌛", key: rawKey } });
            resolve(false);
          }, CONFIRM_TIMEOUT_MS);

          pending.set(msgKey.id, { resolve, rawKey, msgKey, chatId, hooks, timer });
        });
      };
    },

    /** Number of pending confirmations (for testing/monitoring). */
    get size() {
      return pending.size;
    },

    /** Resolve all pending confirmations as false and clear the registry. */
    clear() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(false);
      }
      pending.clear();
    },
  };
}

/**
 * @typedef {(msg: BaileysMessage, type: "buffer", opts: {}) => Promise<Buffer>} DownloadMediaFn
 */

/**
 * Download media from a Baileys message and return content blocks.
 * @param {BaileysMessage} baileysMessage
 * @param {{ mimetype?: string | null, caption?: string | null }} mediaMessage
 * @param {"image" | "video" | "audio"} type
 * @param {DownloadMediaFn} downloadFn
 * @returns {Promise<IncomingContentBlock[]>}
 */
async function downloadMediaToBlocks(baileysMessage, mediaMessage, type, downloadFn) {
  /** @type {IncomingContentBlock[]} */
  const blocks = [];
  const buffer = await downloadFn(baileysMessage, "buffer", {});
  const base64Data = buffer.toString("base64");
  const mimetype = mediaMessage.mimetype;

  if (type === "image" && !mimetype) {
    blocks.push({ type: "text", text: "Error reading image: No mimetype found" });
  } else {
    blocks.push(/** @type {IncomingContentBlock} */ ({
      type,
      encoding: "base64",
      mime_type: mimetype || undefined,
      data: base64Data,
    }));
  }

  if (mediaMessage.caption) {
    blocks.push({ type: "text", text: mediaMessage.caption });
  }

  return blocks;
}

/**
 * @param {BaileysMessage} baileysMessage
 * @param {DownloadMediaFn} [downloadFn]
 * @returns {Promise<{ content: IncomingContentBlock[], quotedSenderId: string | undefined }>}
 */
export async function getMessageContent(baileysMessage, downloadFn = downloadMediaMessage) {
  /** @type {IncomingContentBlock[]} */
  const content = [];
  /** @type {string | undefined} */
  let quotedSenderId;

  // Check for quoted message content
  const contextInfo = getContextInfo(baileysMessage.message);
  const quotedMessage = contextInfo?.quotedMessage;

  if (quotedMessage) {
    const quoteText = quotedMessage.conversation
      || quotedMessage.extendedTextMessage?.text
      || quotedMessage.imageMessage?.caption
      || quotedMessage.videoMessage?.caption
      || quotedMessage.documentMessage?.caption

    const rawQuotedSenderId = contextInfo?.participant;

    /** @type {QuoteContentBlock} */
    const quote = {
      type: "quote",
      content: [],
    };

    if (rawQuotedSenderId) {
      const stripped = rawQuotedSenderId.split("@")[0];
      quote.quotedSenderId = stripped;
      quotedSenderId = stripped;
    }

    if (quoteText) {
      quote.content.push(
        /** @type {TextContentBlock} */
        ({
          type: "text",
          text: quoteText,
        })
      )
    }

    // Download quoted media (image/video/audio)
    const quotedImage = quotedMessage.imageMessage;
    const quotedVideo = quotedMessage.videoMessage || quotedMessage.ptvMessage;
    const quotedAudio = quotedMessage.audioMessage;
    const quotedMedia = quotedImage || quotedVideo || quotedAudio;

    if (quotedMedia) {
      const mediaType = quotedImage ? "image" : quotedAudio ? "audio" : "video";
      try {
        const fakeMsg = /** @type {BaileysMessage} */ ({ message: quotedMessage });
        const mediaBlocks = await downloadMediaToBlocks(fakeMsg, quotedMedia, mediaType, downloadFn);
        quote.content.push(...mediaBlocks);
      } catch {
        quote.content.push(/** @type {TextContentBlock} */ ({
          type: "text",
          text: `[Quoted ${mediaType}]`,
        }));
      }
    }

    content.push(quote);
  }

  // Check for image content (including quoted images)
  const imageMessage = baileysMessage.message?.imageMessage;
  const videoMessage = baileysMessage.message?.videoMessage
    || baileysMessage.message?.ptvMessage;
  const audioMessage = baileysMessage.message?.audioMessage;
  const textMessage = baileysMessage.message?.conversation
    || baileysMessage.message?.extendedTextMessage?.text
    || baileysMessage.message?.documentMessage?.caption

  if (imageMessage) {
    content.push(...await downloadMediaToBlocks(baileysMessage, imageMessage, "image", downloadFn));
  }

  if (videoMessage) {
    content.push(...await downloadMediaToBlocks(baileysMessage, videoMessage, "video", downloadFn));
  }

  if (audioMessage) {
    content.push(...await downloadMediaToBlocks(baileysMessage, audioMessage, "audio", downloadFn));
  }

  if (textMessage) {
    // Handle text message
    content.push({
      type: "text",
      text: textMessage,
    });
  }

  if (content.length === 0) {
    log.debug("Unknown baileysMessage", JSON.stringify(baileysMessage, null, 2));
  }

  return { content, quotedSenderId };
}

/**
 * Edit a previously sent WhatsApp message (text or image caption).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid
 * @param {import('@whiskeysockets/baileys').WAMessageKey} key
 * @param {string} newText
 * @param {boolean} isImage
 */
export async function editWhatsAppMessage(sock, jid, key, newText, isImage) {
  if (isImage) {
    // Edit image caption via raw protocolMessage (no image re-upload needed).
    // See: https://github.com/WhiskeySockets/Baileys/discussions/498
    // The `edit: '1'` additionalAttribute is required by the WA protocol for edits.
    await sock.relayMessage(jid, {
      protocolMessage: {
        key,
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        editedMessage: { imageMessage: { caption: newText } },
      },
    }, { additionalAttributes: { edit: "1" } });
  } else {
    await sock.sendMessage(jid, { text: newText, edit: key });
  }
}

/** @type {Record<MessageSource, string>} */
const SOURCE_PREFIX = {
  "llm": "🤖",
  "tool-call": "🔧",
  "tool-result": "✅",
  "error": "❌",
  "warning": "⚠️",
  "usage": "📊",
  "memory": "🧠",
};

/**
 * Dispatch SendContent as WhatsApp messages with a source-based prefix.
 * Returns an editor function for the last text message sent (if any),
 * allowing callers to update the message in-place.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {MessageSource} source
 * @param {SendContent} content
 * @param {{ quoted?: BaileysMessage }} [options]
 * @returns {Promise<MessageEditor | undefined>}
 */
export async function sendBlocks(sock, chatId, source, content, options) {
  const prefix = SOURCE_PREFIX[source];
  const blocks = typeof content === "string"
    ? [/** @type {ToolContentBlock} */ ({ type: "text", text: content })]
    : Array.isArray(content) ? content : [content];

  const instructions = await renderBlocks(blocks, prefix);

  /** @type {import('@whiskeysockets/baileys').WAMessageKey | undefined} */
  let lastSentKey;
  let lastSentIsImage = false;

  for (const instr of instructions) {
    /** @type {import('@whiskeysockets/baileys').WAMessage | undefined} */
    let sent;
    switch (instr.kind) {
      case "text":
        sent = await sock.sendMessage(chatId, { text: instr.text }, options);
        if (instr.editable && sent?.key) { lastSentKey = sent.key; lastSentIsImage = false; }
        break;
      case "image":
        sent = await sock.sendMessage(chatId, {
          image: instr.image,
          ...(instr.caption && { caption: instr.caption }),
        }, options);
        if (instr.editable && sent?.key) { lastSentKey = sent.key; lastSentIsImage = true; }
        break;
      case "video":
        await sock.sendMessage(chatId, {
          video: instr.video,
          mimetype: instr.mimetype,
          jpegThumbnail: "",
          ...(instr.caption && { caption: instr.caption }),
        }, options);
        break;
      case "audio":
        await sock.sendMessage(chatId, {
          audio: instr.audio,
          mimetype: instr.mimetype,
        }, options);
        break;
    }
  }

  if (!lastSentKey) return undefined;

  const isImage = lastSentIsImage;
  const editKey = lastSentKey;

  /** @type {MessageEditor} */
  const editor = /** @type {MessageEditor} */ (async (newText) => {
    await editWhatsAppMessage(sock, chatId, editKey, `${prefix} ${newText}`, isImage);
  });
  editor.keyId = editKey.id ?? undefined;
  editor.isImage = isImage;
  return editor;
}

/**
 * Internal method to process incoming messages and create enriched context
 * @param {BaileysMessage} baileysMessage - Raw Baileys message
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {(message: IncomingContext) => Promise<void>} messageHandler
 * @param {ConfirmRegistry} confirmRegistry
 */
export async function adaptIncomingMessage(baileysMessage, sock, messageHandler, confirmRegistry) {
  // Extract message content from Baileys format
  // Ignore status updates
  if (baileysMessage.key.remoteJid === "status@broadcast") {
    return;
  }

  const { content, quotedSenderId } = await getMessageContent(baileysMessage);

  if (content.length === 0) {
    return
  }

  let chatId = baileysMessage.key.remoteJid || "";

  // Baileys sometimes uses LID (@lid) instead of phone number (@s.whatsapp.net)
  // for the same 1:1 chat. Normalize to PN so settings/messages stay consistent.
  if (isLidUser(chatId)) {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(chatId);
    if (pn) {
      chatId = jidNormalizedUser(pn);
    }
  }
  // Baileys key type doesn't declare LID/PID fields used for sender identification
  const key = /** @type {typeof baileysMessage.key & { participantLid?: string, participantPid?: string, senderLid?: string, senderPid?: string }} */ (baileysMessage.key);
  /** @type {string[]} */
  const senderIds = [];
  senderIds.push(String(key.participant || key.remoteJid || "unknown"));
  senderIds.push(
    String(
      key.participantLid
      || key.participantPid
      || key.senderLid
      || key.senderPid
      || "unknown",
    ),
  );

  const isGroup = !!chatId?.endsWith("@g.us");

  // Create timestamp
  const timestamp =
    (typeof baileysMessage.messageTimestamp === "number")
      ? new Date(baileysMessage.messageTimestamp * 1000)
      : (!baileysMessage.messageTimestamp)
        ? new Date()
        : new Date(baileysMessage.messageTimestamp.toNumber() * 1000);


  const selfIds = getSelfIds(sock);

  /** @type {IncomingContext} */
  const messageContext = {
    // Message data
    chatId,
    senderIds: senderIds.map(id => id.split("@")[0]),
    senderName: baileysMessage.pushName || "",
    content: content,
    isGroup,
    timestamp,
    quotedSenderId,

    // High-level actions scoped to this message
    getIsAdmin: async () => {
      if (!isGroup) return true;
      try {
        const groupMetadata = await sock.groupMetadata(chatId);
        const participant = groupMetadata.participants.find(
          participant => senderIds.includes(participant.id)
        );
        return participant?.admin === "admin" || participant?.admin === "superadmin";
      } catch (error) {
        log.error("Error checking group admin status:", error);
        return false;
      }
    },

    reactToMessage: async (emoji) => {
      await sock.sendMessage(chatId, {
        react: { text: emoji, key: baileysMessage.key },
      });
    },

    sendPoll: async (name, options, selectableCount = 0) => {
      const sent = await sock.sendMessage(chatId, {
        poll: { name, values: options, selectableCount },
      });
      const pollMsgId = sent?.key?.id;
      log.debug(`sendPoll: msgId=${pollMsgId}, key=${JSON.stringify(sent?.key)}`);
      if (pollMsgId) {
        // Evict oldest entry if at capacity (Map iterates in insertion order)
        if (sentPolls.size >= MAX_SENT_POLLS) {
          const oldest = sentPolls.keys().next().value;
          if (oldest) sentPolls.delete(oldest);
        }
        sentPolls.set(pollMsgId, sent);
        setTimeout(() => sentPolls.delete(pollMsgId), POLL_TTL_MS);
      }
    },

    send: (source, content) => sendBlocks(sock, chatId, source, content),

    reply: (source, content) => sendBlocks(sock, chatId, source, content, { quoted: baileysMessage }),

    confirm: confirmRegistry.createConfirm(sock, chatId),

    sendPresenceUpdate: async (presence) => {
      await sock.sendPresenceUpdate(presence, chatId);
    },

    // Bot info
    selfIds: selfIds || [],
    selfName: sock.user?.name || "",
  };

  // Call the user-provided message handler with enriched context
  await messageHandler(messageContext);
}

/**
 * @typedef {{ key: { id: string; remoteJid: string }, reaction: { text: string } }} ReactionEvent
 */

/**
 * @typedef {{ chatId: string, selectedOptions: string[] }} PollVoteEvent
 */

/**
 * Register event handlers on a Baileys socket.
 * @param {{ current: import('@whiskeysockets/baileys').WASocket }} sockRef
 * @param {() => Promise<void>} saveCreds
 * @param {(message: IncomingContext) => Promise<void>} onMessageHandler
 * @param {() => Promise<void>} reconnect
 * @param {ConfirmRegistry} confirmRegistry
 * @param {((event: ReactionEvent, sock: import('@whiskeysockets/baileys').WASocket) => Promise<void>) | null} [onReaction]
 * @param {((event: PollVoteEvent) => Promise<void>) | null} [onPollVote]
 */
function registerHandlers(sockRef, saveCreds, onMessageHandler, reconnect, confirmRegistry, onReaction = null, onPollVote = null) {
  sockRef.current.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        exec(`echo "${qr}" | qrencode -t ansiutf8`, (error, stdout, stderr) => {
          if (error) {
            log.error(error);
            log.error(stderr);
            return;
          }
          log.info(stdout);
        });
      }

      if (connection === "close") {
        const statusCode = /** @type {{ output?: { statusCode?: number } } | undefined} */ (lastDisconnect?.error)?.output?.statusCode;
        log.info(
          "Connection closed due to ",
          lastDisconnect?.error,
          ", status code:",
          statusCode,
        );
        if (needsAuthReset(lastDisconnect) && !sessionResetInProgress) {
          sessionResetInProgress = true;
          log.warn(`Auth failure (${statusCode}). Clearing auth and requesting re-pair...`);
          await rm(AUTH_DIR, { recursive: true, force: true });
          sendAlertEmail(
            `WhatsApp Bot: Auth failure (${statusCode})`,
            `The WhatsApp bot connection failed with status ${statusCode}.\n`
            + "Auth credentials have been cleared and a QR code is being displayed.\n"
            + "Please scan the QR code within 5 minutes or the process will exit.\n"
            + `Time: ${new Date().toISOString()}`,
          );
          sockRef.current.end(undefined);
          await reconnect();
          qrExitTimer = setTimeout(() => {
            log.error("QR code was not scanned within 5 minutes. Exiting.");
            process.exit(1);
          }, QR_TIMEOUT_MS);
        } else if (needsAuthReset(lastDisconnect) && sessionResetInProgress) {
          log.error(`Auth still failing (${statusCode}) after reset. Exiting.`);
          process.exit(1);
        } else if (statusCode !== 401) {
          sockRef.current.end(undefined);
          await new Promise(resolve => setTimeout(resolve, 1000));
          await reconnect();
        }
      } else if (connection === "open") {
        if (qrExitTimer) {
          clearTimeout(qrExitTimer);
          qrExitTimer = null;
          sessionResetInProgress = false;
          log.info("QR code scanned successfully, exit timer cancelled.");
        }
        log.info("WhatsApp connection opened");
        const selfIds = getSelfIds(sockRef.current);
        log.debug("Self IDs:", selfIds, JSON.stringify(sockRef.current.user, null, 2));
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
    }

    if (events["messages.upsert"]) {
      const { messages } = events["messages.upsert"];
      for (const message of messages) {
        if (message.key.fromMe || !message.message) continue;

        // Handle poll vote messages: manually decrypt and resolve via onPollVote.
        // Baileys' internal poll decryption is commented out, so we do it ourselves.
        if (message.message?.pollUpdateMessage && onPollVote) {
          try {
            const result = await decryptAndResolvePollVote(message, sockRef.current);
            if (result) await onPollVote(result);
          } catch (err) {
            log.error("Error processing poll vote from upsert:", err);
          }
          continue; // Don't process poll votes as regular messages
        }

        await adaptIncomingMessage(message, sockRef.current, onMessageHandler, confirmRegistry);
      }
    }

    if (events["messages.reaction"]) {
      /** @type {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string } }>} */
      const normalized = [];
      for (const event of events["messages.reaction"]) {
        const { key, reaction } = event;
        if (!key.id || !key.remoteJid || !reaction.text) continue;
        normalized.push({ key: { id: key.id, remoteJid: key.remoteJid }, reaction: { text: reaction.text } });
      }

      // Route to pending confirmations (single registry, no per-confirm listeners)
      confirmRegistry.handleReactions(normalized, sockRef.current);

      if (onReaction) {
        for (const event of normalized) {
          try {
            await onReaction(event, sockRef.current);
          } catch (err) {
            log.error("Error in onReaction handler:", err);
          }
        }
      }
    }
  });
}

// TODO: add reconnect integration test

/**
 * @typedef {{
 *   onMessage: (message: IncomingContext) => Promise<void>;
 *   onReaction?: (event: ReactionEvent, sock: import('@whiskeysockets/baileys').WASocket) => Promise<void>;
 *   onPollVote?: (event: PollVoteEvent) => Promise<void>;
 * }} ConnectOptions
 */

/**
 * Initialize WhatsApp connection and set up message handling
 * @param {((message: IncomingContext) => Promise<void>) | ConnectOptions} handlerOrOptions
 */
export async function connectToWhatsApp(handlerOrOptions) {
  const options = typeof handlerOrOptions === "function"
    ? { onMessage: handlerOrOptions }
    : handlerOrOptions;
  const { onMessage, onReaction, onPollVote } = options;

  const { version } = await fetchLatestWaWebVersion();
  log.info("Using WA Web version:", version);

  const { state, saveCreds } = await useMultiFileAuthState(
    AUTH_DIR,
  );

  /** @type {{ current: import('@whiskeysockets/baileys').WASocket }} */
  const sockRef = {
    current: makeWASocket({
      version,
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
    }),
  };

  // Single registry shared across reconnects (message IDs are globally unique).
  const confirmRegistry = createConfirmRegistry();

  async function reconnect() {
    const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(
      AUTH_DIR,
    );
    sockRef.current = makeWASocket({
      version,
      auth: newState,
      browser: Browsers.ubuntu("Chrome"),
    });
    registerHandlers(sockRef, newSaveCreds, onMessage, reconnect, confirmRegistry, onReaction, onPollVote);
  }

  registerHandlers(sockRef, saveCreds, onMessage, reconnect, confirmRegistry, onReaction, onPollVote);

  return {
    async closeWhatsapp() {
      log.info("Cleaning up WhatsApp connection...");
      try {
        sockRef.current.end(undefined);
      } catch (error) {
        log.error("Error during WhatsApp cleanup:", error);
      }
    },
    /** @param {string} chatId @param {string} text */
    async sendToChat(chatId, text) {
      await sockRef.current.sendMessage(chatId, { text });
    },
  }
}
