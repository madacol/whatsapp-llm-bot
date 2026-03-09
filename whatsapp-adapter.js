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
} from "@whiskeysockets/baileys";
import { exec } from "child_process";
import { rm } from "fs/promises";
import { needsAuthReset, sendAlertEmail } from "./notifications.js";
import { renderCodeToImages, renderDiffToImages, MIN_LINES_FOR_IMAGE } from "./code-image-renderer.js";
import { createLogger } from "./logger.js";

const log = createLogger("whatsapp");

/**
 * Languages that should be rendered as syntax-highlighted images.
 * Code blocks without a language or with non-programming identifiers
 * (e.g. "text", "log", "output", "plaintext") are sent as formatted text.
 */
const CODE_IMAGE_LANGUAGES = new Set([
  // Systems / compiled
  "c", "cpp", "csharp", "go", "rust", "java", "kotlin", "swift", "scala",
  "dart", "zig", "nim", "d", "haskell", "ocaml", "fsharp", "elixir", "erlang",
  "clojure", "fortran", "pascal", "ada", "assembly", "asm", "wasm",
  // Web / scripting
  "javascript", "js", "typescript", "ts", "jsx", "tsx", "python", "py",
  "ruby", "rb", "php", "perl", "lua", "r", "julia", "groovy",
  // Shell
  "bash", "sh", "zsh", "fish", "powershell", "ps1", "bat", "cmd",
  // Markup / config that benefits from highlighting
  "html", "css", "scss", "sass", "less", "xml", "svg",
  "json", "yaml", "yml", "toml", "ini", "graphql", "sql",
  // Other
  "dockerfile", "makefile", "cmake", "nginx", "terraform", "hcl",
  "proto", "protobuf", "latex", "tex", "matlab", "objectivec", "objc",
  "vue", "svelte", "astro", "mdx",
]);

/**
 * Check whether a code block should be rendered as a syntax-highlighted image
 * (true) or sent as plain formatted text (false).
 * Requires a recognized programming language and at least MIN_LINES_FOR_IMAGE lines.
 * @param {string} lang
 * @param {string} code
 * @returns {boolean}
 */
function shouldRenderAsImage(lang, code) {
  if (!CODE_IMAGE_LANGUAGES.has(lang.toLowerCase())) return false;
  const lineCount = code.split("\n").length;
  return lineCount >= MIN_LINES_FOR_IMAGE;
}

/**
 * Stores sent poll creation messages keyed by message ID so we can
 * decode incoming poll votes via getAggregateVotesInPollMessage().
 * Entries are cleaned up after 10 minutes.
 * @type {Map<string, import('@whiskeysockets/baileys').WAMessage>}
 */
const sentPolls = new Map();
const POLL_TTL_MS = 10 * 60 * 1000;

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

  /** @type {import('@whiskeysockets/baileys').WAMessageKey | undefined} */
  let lastTextKey;

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        const sent = await sock.sendMessage(chatId, { text: `${prefix} ${block.text}` }, options);
        if (sent?.key) lastTextKey = sent.key;
        break;
      }
      case "markdown": {
        // Split markdown into text segments and fenced code blocks (not inline code).
        // Requires newline after opening ``` to distinguish from inline triple backticks.
        // Non-image code blocks are kept inline with surrounding text; only image-rendered
        // code blocks force a message split (since they must be sent as separate images).
        const parts = block.text.split(/(```\w*\n[\s\S]*?```)/g);

        // Accumulate text segments and non-image code blocks into a single message.
        // Flush the buffer whenever we hit an image-rendered code block.
        let textBuffer = "";

        const flushText = async () => {
          const trimmed = textBuffer.trim();
          if (trimmed) {
            const sent = await sock.sendMessage(chatId, { text: `${prefix} ${trimmed}` }, options);
            if (sent?.key) lastTextKey = sent.key;
          }
          textBuffer = "";
        };

        for (const part of parts) {
          const codeMatch = part.match(/^```(\w*)\n([\s\S]*?)```$/);
          if (codeMatch) {
            const lang = codeMatch[1] || "";
            const code = codeMatch[2].trimEnd();
            if (lang && shouldRenderAsImage(lang, code)) {
              // Flush accumulated text before sending images
              await flushText();
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
                textBuffer += "\n```\n" + code + "\n```\n";
              }
            } else {
              // Non-programming code block — keep inline as monospace text
              textBuffer += "\n```\n" + code + "\n```\n";
            }
          } else {
            const converted = markdownToWhatsApp(part).trim();
            if (converted) {
              textBuffer += (textBuffer ? "\n" : "") + converted;
            }
          }
        }
        // Flush any remaining text
        await flushText();
        break;
      }
      case "code": {
        if (block.language && shouldRenderAsImage(block.language, block.code)) {
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
        } else {
          // Non-programming code block — send as formatted text
          const caption = block.language ? `_${block.language}_\n` : "";
          await sock.sendMessage(chatId, {
            text: caption + "```\n" + block.code + "\n```",
          }, options);
        }
        break;
      }
      case "diff": {
        const diffBlock = /** @type {DiffContentBlock} */ (block);
        try {
          const images = await renderDiffToImages(diffBlock.oldStr, diffBlock.newStr, diffBlock.language);
          for (const image of images) {
            await sock.sendMessage(chatId, {
              image,
              ...(diffBlock.language && { caption: `diff · ${diffBlock.language}` }),
            }, options);
          }
        } catch (err) {
          log.error("Diff image rendering failed, falling back to text:", err);
          // Fallback: show as text diff
          const lines = [];
          for (const line of diffBlock.oldStr.split("\n")) lines.push(`- ${line}`);
          for (const line of diffBlock.newStr.split("\n")) lines.push(`+ ${line}`);
          await sock.sendMessage(chatId, { text: "```\n" + lines.join("\n") + "\n```" }, options);
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
          mimetype: block.mime_type || "video/mp4",
          jpegThumbnail: "",
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

  if (!lastTextKey) return undefined;

  /** @type {MessageEditor} */
  const editor = async (newText) => {
    await sock.sendMessage(chatId, { text: `${prefix} ${newText}`, edit: lastTextKey });
  };
  return editor;
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
      const sent = await sock.sendMessage(chatId, {
        poll: { name, values: options, selectableCount },
      });
      const pollMsgId = sent?.key?.id;
      log.debug(`sendPoll: msgId=${pollMsgId}, key=${JSON.stringify(sent?.key)}`);
      if (pollMsgId) {
        sentPolls.set(pollMsgId, sent);
        setTimeout(() => sentPolls.delete(pollMsgId), POLL_TTL_MS);
      }
    },

    send: (source, content) => sendBlocks(sock, chatId, source, content),

    reply: (source, content) => sendBlocks(sock, chatId, source, content, { quoted: baileysMessage }),

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
 * @typedef {{ chatId: string, selectedOptions: string[] }} PollVoteEvent
 */

/**
 * Register event handlers on a Baileys socket.
 * @param {{ current: import('@whiskeysockets/baileys').WASocket }} sockRef
 * @param {() => Promise<void>} saveCreds
 * @param {(message: IncomingContext) => Promise<void>} onMessageHandler
 * @param {() => Promise<void>} reconnect
 * @param {((event: ReactionEvent, sock: import('@whiskeysockets/baileys').WASocket) => Promise<void>) | null} [onReaction]
 * @param {((event: PollVoteEvent) => Promise<void>) | null} [onPollVote]
 */
function registerHandlers(sockRef, saveCreds, onMessageHandler, reconnect, onReaction = null, onPollVote = null) {
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
        const pollUpdate = message.message?.pollUpdateMessage;
        if (pollUpdate && onPollVote) {
          const creationKeyId = pollUpdate.pollCreationMessageKey?.id;
          log.debug(`Poll vote upsert: creationKeyId=${creationKeyId}`);
          if (creationKeyId) {
            const pollCreation = sentPolls.get(creationKeyId);
            if (pollCreation) {
              try {
                const encKey = pollCreation.message?.messageContextInfo?.messageSecret;
                if (!encKey || !pollUpdate.vote) {
                  log.debug("Poll vote missing encKey or vote payload, skipping");
                } else {
                  // Decrypt the vote using Baileys' decryptPollVote.
                  // The JIDs must match the addressing mode used for encryption.
                  // When LID addressing is active, WhatsApp encrypts with LID JIDs,
                  // so we must decrypt with LID JIDs too (not phone numbers).
                  // getKeyAuthor() returns the Alt (opposite) format, so we bypass it
                  // and use the primary JID fields directly.
                  const voteJid = message.key.participant || message.key.remoteJid || "";
                  const isLidVote = isLidUser(voteJid);

                  let meId, pollCreatorJid, voterJid;
                  if (isLidVote) {
                    // LID addressing: use LID-format JIDs for decryption
                    meId = sockRef.current.user?.lid
                      ? jidNormalizedUser(sockRef.current.user.lid)
                      : jidNormalizedUser(sockRef.current.user?.id ?? "");
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
                    meId = jidNormalizedUser(sockRef.current.user?.id ?? "");
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
                  // Baileys may use pollCreationMessage, V2, V3, etc. depending on version.
                  const pcMsg = pollCreation.message;
                  const pollData = pcMsg?.pollCreationMessage
                    || pcMsg?.pollCreationMessageV2
                    || pcMsg?.pollCreationMessageV3
                    || pcMsg?.pollCreationMessageV4
                    || pcMsg?.pollCreationMessageV5;
                  const options = /** @type {Array<{optionName?: string}>} */ (/** @type {*} */ (pollData)?.options ?? []);
                  log.debug(`Poll options lookup: keys=${Object.keys(pcMsg || {}).filter(k => k.includes("poll"))}, optionCount=${options.length}`);
                  const selectedHashes = (decrypted.selectedOptions ?? []).map(
                    (/** @type {Uint8Array} */ h) => Buffer.from(h).toString("hex"),
                  );

                  // Hash each option name and match
                  const { createHash } = await import("crypto");
                  const selected = options
                    .filter(opt => {
                      if (!opt.optionName) return false;
                      const hash = createHash("sha256").update(opt.optionName).digest("hex");
                      return selectedHashes.includes(hash);
                    })
                    .map(opt => opt.optionName ?? "");

                  log.debug(`Poll vote decoded: selected=[${selected.join(",")}]`);
                  if (selected.length > 0) {
                    let chatId = message.key.remoteJid || pollCreation.key?.remoteJid || "";
                    if (isLidUser(chatId)) {
                      const pn = await sockRef.current.signalRepository.lidMapping.getPNForLID(chatId);
                      if (pn) chatId = jidNormalizedUser(pn);
                    }
                    await onPollVote({ chatId, selectedOptions: selected });
                  }
                }
              } catch (err) {
                log.error("Error processing poll vote from upsert:", err);
              }
            } else {
              log.debug(`Poll creation not found in sentPolls for id=${creationKeyId}`);
            }
          }
          continue; // Don't process poll votes as regular messages
        }

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

  async function reconnect() {
    const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(
      AUTH_DIR,
    );
    sockRef.current = makeWASocket({
      version,
      auth: newState,
      browser: Browsers.ubuntu("Chrome"),
    });
    registerHandlers(sockRef, newSaveCreds, onMessage, reconnect, onReaction, onPollVote);
  }

  registerHandlers(sockRef, saveCreds, onMessage, reconnect, onReaction, onPollVote);

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
