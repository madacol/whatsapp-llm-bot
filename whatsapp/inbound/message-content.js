import { downloadMediaMessage, proto } from "@whiskeysockets/baileys";
import { createLogger } from "../../logger.js";
import { hydrateHdRef } from "../../whatsapp-hd-media.js";
import { processHdImageMessage } from "../../whatsapp-hd-media.js";

const log = createLogger("whatsapp:content");

/**
 * @typedef {(msg: BaileysMessage, type: "buffer", opts: {}) => Promise<Buffer>} DownloadMediaFn
 */

/**
 * @typedef {{
 *   content: IncomingContentBlock[],
 *   quotedSenderId: string | undefined,
 *   hdChild?: { parentMessageId?: string, ref: { url?: string, directPath?: string, mediaKey: string, mimetype?: string }, imageBlock: ImageContentBlock | null },
 *   hdParentMessageId?: string,
 * }} MessageContentResult
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
 * @param {BaileysMessage["message"] | proto.IMessage | undefined} message
 * @returns {string | undefined}
 */
function getTextMessage(message) {
  return message?.conversation
    || message?.extendedTextMessage?.text
    || message?.documentMessage?.caption
    || undefined;
}

/**
 * @param {proto.IMessage | undefined} quotedMessage
 * @returns {string | undefined}
 */
function getQuotedText(quotedMessage) {
  return quotedMessage?.conversation
    || quotedMessage?.extendedTextMessage?.text
    || quotedMessage?.imageMessage?.caption
    || quotedMessage?.videoMessage?.caption
    || quotedMessage?.documentMessage?.caption
    || undefined;
}

/**
 * @returns {MessageContentResult}
 */
function createEmptyMessageContentResult() {
  return {
    content: [],
    quotedSenderId: undefined,
    hdChild: undefined,
    hdParentMessageId: undefined,
  };
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
 * @param {proto.IContextInfo | undefined} contextInfo
 * @param {DownloadMediaFn} downloadFn
 * @returns {Promise<{ quoteBlock: QuoteContentBlock | null, quotedSenderId: string | undefined }>}
 */
async function extractQuotedContent(contextInfo, downloadFn) {
  const quotedMessage = contextInfo?.quotedMessage;
  if (!quotedMessage) {
    return { quoteBlock: null, quotedSenderId: undefined };
  }

  /** @type {QuoteContentBlock} */
  const quoteBlock = {
    type: "quote",
    content: [],
  };

  const rawQuotedSenderId = typeof contextInfo?.participant === "string"
    ? contextInfo.participant
    : undefined;
  const quotedSenderId = rawQuotedSenderId?.split("@")[0];
  if (quotedSenderId) {
    quoteBlock.quotedSenderId = quotedSenderId;
  }

  const quoteText = getQuotedText(quotedMessage);
  if (quoteText) {
    quoteBlock.content.push({ type: "text", text: quoteText });
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
      quoteBlock.content.push(...mediaBlocks);
    } catch {
      quoteBlock.content.push({
        type: "text",
        text: `[Quoted ${mediaType}]`,
      });
    }
  }

  return {
    quoteBlock: quoteBlock.content.length > 0 || quoteBlock.quotedSenderId ? quoteBlock : null,
    quotedSenderId,
  };
}

/**
 * @param {BaileysMessage} baileysMessage
 * @returns {{
 *   imageMessage: NonNullable<BaileysMessage["message"]>["imageMessage"] | undefined,
 *   videoMessage: NonNullable<BaileysMessage["message"]>["videoMessage"] | NonNullable<BaileysMessage["message"]>["ptvMessage"] | undefined,
 *   audioMessage: NonNullable<BaileysMessage["message"]>["audioMessage"] | undefined,
 * }}
 */
function getDirectMediaMessages(baileysMessage) {
  const associatedInnerMessage = baileysMessage.message?.associatedChildMessage?.message;
  return {
    imageMessage: baileysMessage.message?.imageMessage ?? associatedInnerMessage?.imageMessage,
    videoMessage: baileysMessage.message?.videoMessage || baileysMessage.message?.ptvMessage,
    audioMessage: baileysMessage.message?.audioMessage,
  };
}

/**
 * @param {BaileysMessage} baileysMessage
 * @param {DownloadMediaFn} downloadFn
 * @returns {Promise<{
 *   content: IncomingContentBlock[],
 *   hdChild?: { parentMessageId?: string, ref: { url?: string, directPath?: string, mediaKey: string, mimetype?: string }, imageBlock: ImageContentBlock | null },
 *   hdParentMessageId?: string,
 * }>}
 */
async function extractDirectContent(baileysMessage, downloadFn) {
  /** @type {IncomingContentBlock[]} */
  const content = [];
  /** @type {{ parentMessageId?: string, ref: { url?: string, directPath?: string, mediaKey: string, mimetype?: string }, imageBlock: ImageContentBlock | null } | undefined} */
  let hdChild;
  /** @type {string | undefined} */
  let hdParentMessageId;

  const { imageMessage, videoMessage, audioMessage } = getDirectMediaMessages(baileysMessage);

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

  const textMessage = getTextMessage(baileysMessage.message);
  if (textMessage) {
    content.push({
      type: "text",
      text: textMessage,
    });
  }

  return { content, hdChild, hdParentMessageId };
}

/**
 * @param {BaileysMessage} baileysMessage
 * @param {DownloadMediaFn} [downloadFn]
 * @returns {Promise<MessageContentResult>}
 */
export async function getMessageContent(baileysMessage, downloadFn = downloadMediaMessage) {
  if (baileysMessage.message?.reactionMessage) {
    return createEmptyMessageContentResult();
  }

  const contextInfo = getContextInfo(baileysMessage.message);
  const quoted = await extractQuotedContent(contextInfo, downloadFn);
  const direct = await extractDirectContent(baileysMessage, downloadFn);
  const content = [
    ...(quoted.quoteBlock ? [quoted.quoteBlock] : []),
    ...direct.content,
  ];

  if (content.length === 0) {
    log.debug("Unknown baileysMessage", JSON.stringify(baileysMessage, null, 2));
  }

  return {
    content,
    quotedSenderId: quoted.quotedSenderId,
    hdChild: direct.hdChild,
    hdParentMessageId: direct.hdParentMessageId,
  };
}
