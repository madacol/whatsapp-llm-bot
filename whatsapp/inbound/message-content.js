import { downloadMediaMessage, proto } from "@whiskeysockets/baileys";
import { createLogger } from "../../logger.js";
import { hydrateHdRef } from "../../whatsapp-hd-media.js";
import { processHdImageMessage } from "../../whatsapp-hd-media.js";

const log = createLogger("whatsapp:content");

/**
 * @typedef {(msg: BaileysMessage, type: "buffer", opts: {}) => Promise<Buffer>} DownloadMediaFn
 */

/**
 * Extract contextInfo from any Baileys message type that carries it.
 * @param {BaileysMessage['message']} message
 * @returns {proto.IContextInfo | undefined}
 */
function getContextInfo(message) {
  return message?.extendedTextMessage?.contextInfo
    || message?.imageMessage?.contextInfo
    || message?.videoMessage?.contextInfo
    || message?.documentMessage?.contextInfo
    || message?.audioMessage?.contextInfo
    || message?.ptvMessage?.contextInfo
    || message?.stickerMessage?.contextInfo
    || undefined;
}

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
  const mimeType = mediaMessage.mimetype;

  if (type === "image" && !mimeType) {
    blocks.push({ type: "text", text: "Error reading image: No mimetype found" });
  } else {
    blocks.push(/** @type {IncomingContentBlock} */ ({
      type,
      encoding: "base64",
      mime_type: mimeType || undefined,
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
 * @returns {Promise<{
 *   content: IncomingContentBlock[],
 *   quotedSenderId: string | undefined,
 *   hdChild?: { parentMessageId?: string, ref: { url?: string, directPath?: string, mediaKey: string, mimetype?: string }, imageBlock: ImageContentBlock | null },
 *   hdParentMessageId?: string,
 * }>}
 */
export async function getMessageContent(baileysMessage, downloadFn = downloadMediaMessage) {
  /** @type {IncomingContentBlock[]} */
  const content = [];
  /** @type {string | undefined} */
  let quotedSenderId;
  /** @type {{ parentMessageId?: string, ref: { url?: string, directPath?: string, mediaKey: string, mimetype?: string }, imageBlock: ImageContentBlock | null } | undefined} */
  let hdChild;
  /** @type {string | undefined} */
  let hdParentMessageId;

  if (baileysMessage.message?.reactionMessage) {
    return { content, quotedSenderId, hdChild, hdParentMessageId };
  }

  const contextInfo = getContextInfo(baileysMessage.message);
  const quotedMessage = contextInfo?.quotedMessage;

  if (quotedMessage) {
    const quoteText = quotedMessage.conversation
      || quotedMessage.extendedTextMessage?.text
      || quotedMessage.imageMessage?.caption
      || quotedMessage.videoMessage?.caption
      || quotedMessage.documentMessage?.caption;

    const rawQuotedSenderId = typeof contextInfo?.participant === "string"
      ? contextInfo.participant
      : undefined;

    /** @type {QuoteContentBlock} */
    const quote = {
      type: "quote",
      content: [],
    };

    if (rawQuotedSenderId) {
      const strippedSenderId = rawQuotedSenderId.split("@")[0];
      quote.quotedSenderId = strippedSenderId;
      quotedSenderId = strippedSenderId;
    }

    if (quoteText) {
      quote.content.push({
        type: "text",
        text: quoteText,
      });
    }

    const quotedImage = quotedMessage.imageMessage;
    const quotedVideo = quotedMessage.videoMessage || quotedMessage.ptvMessage;
    const quotedAudio = quotedMessage.audioMessage;
    const quotedMedia = quotedImage || quotedVideo || quotedAudio;

    if (quotedMedia) {
      const mediaType = quotedImage ? "image" : quotedAudio ? "audio" : "video";
      try {
        const fakeMessage = /** @type {BaileysMessage} */ ({ message: quotedMessage });
        const mediaBlocks = await downloadMediaToBlocks(fakeMessage, quotedMedia, mediaType, downloadFn);
        quote.content.push(...mediaBlocks);
      } catch {
        quote.content.push({
          type: "text",
          text: `[Quoted ${mediaType}]`,
        });
      }
    }

    content.push(quote);
  }

  const associatedInnerMessage = baileysMessage.message?.associatedChildMessage?.message;
  const imageMessage = baileysMessage.message?.imageMessage ?? associatedInnerMessage?.imageMessage;
  const videoMessage = baileysMessage.message?.videoMessage || baileysMessage.message?.ptvMessage;
  const audioMessage = baileysMessage.message?.audioMessage;
  const textMessage = baileysMessage.message?.conversation
    || baileysMessage.message?.extendedTextMessage?.text
    || baileysMessage.message?.documentMessage?.caption;

  if (imageMessage) {
    const imageResult = await processHdImageMessage(
      baileysMessage,
      imageMessage,
      downloadFn,
      downloadMediaToBlocks,
    );
    if (imageResult.content.length > 0) {
      const firstImage = imageResult.content.find((block) => block.type === "image");
      if (firstImage && firstImage.type === "image") {
        hydrateHdRef(firstImage);
      }
    }
    content.push(...imageResult.content);
    hdChild = imageResult.hdChild;
    hdParentMessageId = imageResult.hdParentMessageId;
  }

  if (videoMessage) {
    content.push(...await downloadMediaToBlocks(baileysMessage, videoMessage, "video", downloadFn));
  }

  if (audioMessage) {
    content.push(...await downloadMediaToBlocks(baileysMessage, audioMessage, "audio", downloadFn));
  }

  if (textMessage) {
    content.push({
      type: "text",
      text: textMessage,
    });
  }

  if (content.length === 0) {
    log.debug("Unknown baileysMessage", JSON.stringify(baileysMessage, null, 2));
  }

  return { content, quotedSenderId, hdChild, hdParentMessageId };
}
