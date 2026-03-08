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
} from "@whiskeysockets/baileys";
import { exec } from "child_process";
import { rm } from "fs/promises";
import { needsAuthReset, sendAlertEmail } from "./notifications.js";
import { renderCodeToImages } from "./code-image-renderer.js";
import { createLogger } from "./logger.js";

const log = createLogger("whatsapp");

/**
 * Convert standard Markdown to WhatsApp-compatible formatting.
 * WhatsApp uses: *bold*, _italic_, ~strikethrough~, ```code```, > quote
 * @param {string} text
 * @returns {string}
 */
function markdownToWhatsApp(text) {
  let result = text;

  // Italic first: *text* (single asterisk) → _text_
  // Must run BEFORE bold conversion so **bold** doesn't get re-matched as italic
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Headers: # Heading → *Heading* (bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Images: ![alt](url) → alt (url) — must be before links
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)");

  // Links: [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Unordered lists: - item or * item → • item (preserve indentation)
  // Use non-breaking spaces (\u00A0) because WhatsApp strips regular leading spaces
  result = result.replace(/^([\t ]*)[-*]\s+/gm, (_match, indent) => {
    const depth = indent ? Math.floor(indent.replace(/\t/g, "  ").length / 2) : 0;
    return "\u00A0\u00A0".repeat(depth) + "• ";
  });

  // Ordered lists: 1. item → 1. item (preserve indentation)
  result = result.replace(/^([\t ]*)(\d+)\.\s+/gm, (_match, indent, num) => {
    const depth = indent ? Math.floor(indent.replace(/\t/g, "  ").length / 2) : 0;
    return "\u00A0\u00A0".repeat(depth) + num + ". ";
  });

  // Horizontal rules: --- or *** or ___ → ———
  result = result.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, "———");

  return result;
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
 * Create a reaction-based confirmation handler.
 * Sends a message, reacts with ⏳, and waits indefinitely for 👍/👎.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @returns {(message: string, hooks?: ConfirmHooks) => Promise<boolean>}
 */
export function createConfirm(sock, chatId) {
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
      /** @param {any[]} reactions */
      function handler(reactions) {
        for (const { key, reaction } of reactions) {
          if (key.id === msgKey.id) {
            if (reaction.text?.startsWith("👍")) {
              sock.ev.off("messages.reaction", handler);
              sock.sendMessage(chatId, {
                react: { text: "✅", key: rawKey },
              });
              if (hooks?.onResolved) {
                hooks.onResolved(msgKey, true);
              }
              resolve(true);
            } else if (reaction.text?.startsWith("👎")) {
              sock.ev.off("messages.reaction", handler);
              sock.sendMessage(chatId, {
                react: { text: "❌", key: rawKey },
              });
              if (hooks?.onResolved) {
                hooks.onResolved(msgKey, false);
              }
              resolve(false);
            }
          }
        }
      }

      sock.ev.on("messages.reaction", handler);
    });
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
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {MessageSource} source
 * @param {SendContent} content
 * @param {{ quoted?: BaileysMessage }} [options]
 */
export async function sendBlocks(sock, chatId, source, content, options) {
  const prefix = SOURCE_PREFIX[source];
  const blocks = typeof content === "string"
    ? [/** @type {ToolContentBlock} */ ({ type: "text", text: content })]
    : Array.isArray(content) ? content : [content];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        await sock.sendMessage(chatId, { text: `${prefix} ${block.text}` }, options);
        break;
      case "markdown": {
        // Split markdown into text segments and fenced code blocks (not inline code)
        // Requires newline after opening ``` to distinguish from inline triple backticks
        const parts = block.text.split(/(```\w*\n[\s\S]*?```)/g);
        for (const part of parts) {
          const codeMatch = part.match(/^```(\w*)\n([\s\S]*?)```$/);
          if (codeMatch) {
            const lang = codeMatch[1] || "";
            const code = codeMatch[2].trimEnd();
            try {
              const images = await renderCodeToImages(code, lang);
              for (const image of images) {
                await sock.sendMessage(chatId, {
                  image,
                  ...(lang && { caption: lang }),
                }, options);
              }
            } catch (err) {
              log.error("Markdown code image rendering failed, falling back to text:", err);
              await sock.sendMessage(chatId, { text: "```\n" + code + "\n```" }, options);
            }
          } else {
            const converted = markdownToWhatsApp(part).trim();
            if (converted) {
              await sock.sendMessage(chatId, { text: `${prefix} ${converted}` }, options);
            }
          }
        }
        break;
      }
      case "code": {
        try {
          const images = await renderCodeToImages(block.code, block.language);
          for (const image of images) {
            await sock.sendMessage(chatId, {
              image,
              ...(block.language && { caption: block.language }),
            }, options);
          }
        } catch (err) {
          log.error("Code image rendering failed, falling back to text:", err);
          await sock.sendMessage(chatId, {
            text: "```\n" + block.code + "\n```",
          }, options);
        }
        break;
      }
      case "image":
        await sock.sendMessage(chatId, {
          image: Buffer.from(block.data, "base64"),
          ...(block.alt && { caption: block.alt }),
        }, options);
        break;
      case "video":
        await sock.sendMessage(chatId, {
          video: Buffer.from(block.data, "base64"),
          ...(block.alt && { caption: block.alt }),
        }, options);
        break;
      case "audio":
        await sock.sendMessage(chatId, {
          audio: Buffer.from(block.data, "base64"),
          mimetype: block.mime_type || "audio/mp4",
        }, options);
        break;
    }
  }
}

/**
 * Internal method to process incoming messages and create enriched context
 * @param {BaileysMessage} baileysMessage - Raw Baileys message
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {(message: IncomingContext) => Promise<void>} messageHandler
 */
export async function adaptIncomingMessage(baileysMessage, sock, messageHandler) {
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
      await sock.sendMessage(chatId, {
        poll: { name, values: options, selectableCount },
      });
    },

    send: async (source, content) => {
      await sendBlocks(sock, chatId, source, content);
    },

    reply: async (source, content) => {
      await sendBlocks(sock, chatId, source, content, { quoted: baileysMessage });
    },

    confirm: createConfirm(sock, chatId),

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
 * Register event handlers on a Baileys socket.
 * @param {{ current: import('@whiskeysockets/baileys').WASocket }} sockRef
 * @param {() => Promise<void>} saveCreds
 * @param {(message: IncomingContext) => Promise<void>} onMessageHandler
 * @param {() => Promise<void>} reconnect
 * @param {((event: ReactionEvent, sock: import('@whiskeysockets/baileys').WASocket) => Promise<void>) | null} [onReaction]
 */
function registerHandlers(sockRef, saveCreds, onMessageHandler, reconnect, onReaction = null) {
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
        await adaptIncomingMessage(message, sockRef.current, onMessageHandler);
      }
    }

    if (events["messages.reaction"] && onReaction) {
      for (const event of events["messages.reaction"]) {
        const { key, reaction } = event;
        if (!key.id || !key.remoteJid || !reaction.text) continue;
        try {
          await onReaction(
            { key: { id: key.id, remoteJid: key.remoteJid }, reaction: { text: reaction.text } },
            sockRef.current,
          );
        } catch (err) {
          log.error("Error in onReaction handler:", err);
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
  const { onMessage, onReaction } = options;

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

  async function reconnect() {
    const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(
      AUTH_DIR,
    );
    sockRef.current = makeWASocket({
      version,
      auth: newState,
      browser: Browsers.ubuntu("Chrome"),
    });
    registerHandlers(sockRef, newSaveCreds, onMessage, reconnect, onReaction);
  }

  registerHandlers(sockRef, saveCreds, onMessage, reconnect, onReaction);

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
