import {
  downloadContentFromMessage,
  generateMessageIDV2,
  generateWAMessage,
  isLidUser,
  jidNormalizedUser,
  proto,
} from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";
import { getRootDb } from "./db.js";
import { createLogger } from "./logger.js";
import { writeMedia } from "./media-store.js";

const log = createLogger("whatsapp-hd-media");

const HD_TIMEOUT_MS = 10_000;

/** @type {Map<string, { promise: Promise<ImageContentBlock | null>, resolve: (block: ImageContentBlock | null) => void }>} */
const hdDeferreds = new Map();

/**
 * @typedef {{ url?: string; directPath?: string; mediaKey: string; mimetype?: string }} HdChildRef
 */

/**
 * @typedef {(msg: BaileysMessage, type: "buffer", opts: {}) => Promise<Buffer>} DownloadMediaFn
 */

/**
 * @typedef {(message: BaileysMessage, mediaMessage: { mimetype?: string | null, caption?: string | null }, type: "image" | "video" | "audio", downloadFn: DownloadMediaFn) => Promise<IncomingContentBlock[]>} DownloadMediaToBlocksFn
 */

/**
 * @param {string} chatId
 * @param {string} parentMessageId
 * @returns {string}
 */
function getHdDeferredKey(chatId, parentMessageId) {
  return `${chatId}\u0000${parentMessageId}`;
}

/**
 * @param {string} chatId
 * @param {string} parentMessageId
 * @returns {Promise<ImageContentBlock | null>}
 */
function createHdDeferred(chatId, parentMessageId) {
  const key = getHdDeferredKey(chatId, parentMessageId);
  /** @type {(block: ImageContentBlock | null) => void} */
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const timeout = setTimeout(() => {
    hdDeferreds.delete(key);
    resolve(null);
  }, HD_TIMEOUT_MS);
  hdDeferreds.set(key, {
    promise,
    resolve: (block) => {
      clearTimeout(timeout);
      resolve(block);
    },
  });
  return promise;
}

/**
 * @param {string} fromChatId
 * @param {string} toChatId
 * @param {string} parentMessageId
 */
export function rekeyHdDeferred(fromChatId, toChatId, parentMessageId) {
  if (fromChatId === toChatId) return;
  const fromKey = getHdDeferredKey(fromChatId, parentMessageId);
  const toKey = getHdDeferredKey(toChatId, parentMessageId);
  const entry = hdDeferreds.get(fromKey);
  if (!entry) return;
  hdDeferreds.delete(fromKey);
  hdDeferreds.set(toKey, entry);
}

/**
 * @param {string} chatId
 * @param {string | undefined} parentMessageId
 * @param {ImageContentBlock | null} block
 */
export function resolveHdDeferred(chatId, parentMessageId, block) {
  if (!parentMessageId) return;
  const deferred = hdDeferreds.get(getHdDeferredKey(chatId, parentMessageId));
  if (deferred) {
    deferred.resolve(block);
  }
}

/**
 * @param {string} chatId
 * @param {MediaRegistry} mediaRegistry
 */
export function reattachHdDeferreds(chatId, mediaRegistry) {
  for (const block of mediaRegistry.values()) {
    if (block.type !== "image") continue;
    const parentMessageId = block._hdParentMessageId;
    const entry = parentMessageId
      ? hdDeferreds.get(getHdDeferredKey(chatId, parentMessageId))
      : undefined;
    if (entry && block._hdRef === null && !(block.getHd instanceof Promise)) {
      block.getHd = entry.promise;
    }
  }
}

/**
 * @param {ImageContentBlock} block
 */
export function hydrateHdRef(block) {
  if (block._hdRef && !(block.getHd instanceof Promise)) {
    const hdRef = block._hdRef;
    block.getHd = (async () => {
      try {
        const mediaKey = Buffer.from(hdRef.mediaKey, "base64");
        const stream = await downloadContentFromMessage(
          { mediaKey, directPath: hdRef.directPath, url: hdRef.url },
          "image",
        );
        /** @type {Buffer[]} */
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const mediaPath = await writeMedia(buffer, hdRef.mimetype || "image/jpeg", "image");
        return /** @type {ImageContentBlock} */ ({
          type: "image",
          path: mediaPath,
          mime_type: hdRef.mimetype || "image/jpeg",
        });
      } catch {
        return null;
      }
    })();
  }
}

/**
 * @param {string} chatId
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {Promise<string>}
 */
export async function normalizeChatId(chatId, sock) {
  if (!isLidUser(chatId)) return chatId;
  const pn = await sock.signalRepository.lidMapping.getPNForLID(chatId);
  return pn ? jidNormalizedUser(pn) : chatId;
}

/**
 * @param {BaileysMessage} baileysMessage
 * @returns {string | undefined}
 */
function getHdParentMessageId(baileysMessage) {
  const messageAssociation = baileysMessage.message?.messageContextInfo?.messageAssociation
    || baileysMessage.message?.associatedChildMessage?.message?.messageContextInfo?.messageAssociation;
  const parentMessageKey = messageAssociation?.parentMessageKey;
  return typeof parentMessageKey?.id === "string" && parentMessageKey.id.length > 0
    ? parentMessageKey.id
    : undefined;
}

/**
 * @param {string} chatId
 * @param {string | undefined} parentMessageId
 * @param {HdChildRef} ref
 * @returns {Promise<void>}
 */
export async function updateStoredHdRef(chatId, parentMessageId, ref) {
  if (!parentMessageId) return;
  try {
    const db = getRootDb();
    const { rows } = await db.query(
      `SELECT message_id, message_data FROM messages
       WHERE chat_id = $1
         AND message_data->>'role' = 'user'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(message_data->'content') AS block
           WHERE block->>'type' = 'image'
             AND block->>'_hdParentMessageId' = $2
         )
       ORDER BY timestamp DESC LIMIT 1`,
      [chatId, parentMessageId],
    );
    if (rows.length === 0) return;

    const row = /** @type {{ message_id: number, message_data: UserMessage }} */ (rows[0]);
    const messageData = row.message_data;
    let updated = false;
    for (const block of messageData.content) {
      if (
        block.type === "image"
        && block._hdRef === null
        && block._hdParentMessageId === parentMessageId
      ) {
        block._hdRef = ref;
        updated = true;
        break;
      }
    }
    if (!updated) return;

    await db.query(
      `UPDATE messages SET message_data = $1 WHERE message_id = $2`,
      [messageData, row.message_id],
    );
    log.info("Updated stored _hdRef for chat/message:", chatId, parentMessageId);
  } catch (err) {
    log.warn("Failed to update stored _hdRef:", err);
  }
}

/**
 * @param {BaileysMessage} baileysMessage
 * @param {import('@whiskeysockets/baileys').proto.Message.IImageMessage} imageMessage
 * @param {DownloadMediaFn} downloadFn
 * @param {DownloadMediaToBlocksFn} downloadMediaToBlocks
 * @returns {Promise<{
 *   content: IncomingContentBlock[],
 *   hdChild?: { parentMessageId?: string, ref: HdChildRef, imageBlock: ImageContentBlock | null },
 *   hdParentMessageId?: string,
 * }>}
 */
export async function processHdImageMessage(baileysMessage, imageMessage, downloadFn, downloadMediaToBlocks) {
  const pairedType = imageMessage.contextInfo?.pairedMediaType;
  const SD_PARENT = proto.ContextInfo.PairedMediaType.SD_IMAGE_PARENT;
  const HD_CHILD = proto.ContextInfo.PairedMediaType.HD_IMAGE_CHILD;
  const assocInnerMessage = baileysMessage.message?.associatedChildMessage?.message;
  const msgForImageDownload = baileysMessage.message?.imageMessage
    ? baileysMessage
    : assocInnerMessage?.imageMessage
      ? /** @type {BaileysMessage} */ ({ key: baileysMessage.key, message: assocInnerMessage })
      : baileysMessage;

  if (pairedType === HD_CHILD) {
    const hdBlocks = await downloadMediaToBlocks(msgForImageDownload, imageMessage, "image", downloadFn);
    const hdImageBlock = /** @type {ImageContentBlock | undefined} */ (hdBlocks.find(block => block.type === "image"));
    const parentMessageId = getHdParentMessageId(baileysMessage);
    if (!imageMessage.mediaKey) {
      return { content: [] };
    }
    return {
      content: [],
      hdChild: {
        parentMessageId,
        imageBlock: hdImageBlock ?? null,
        ref: {
          url: imageMessage.url ?? undefined,
          directPath: imageMessage.directPath ?? undefined,
          mediaKey: typeof imageMessage.mediaKey === "string"
            ? imageMessage.mediaKey
            : Buffer.from(imageMessage.mediaKey).toString("base64"),
          mimetype: imageMessage.mimetype ?? undefined,
        },
      },
    };
  }

  const content = await downloadMediaToBlocks(msgForImageDownload, imageMessage, "image", downloadFn);
  if (pairedType !== SD_PARENT) {
    return { content };
  }

  const parentMessageId = typeof baileysMessage.key.id === "string"
    ? baileysMessage.key.id
    : undefined;
  const chatId = baileysMessage.key.remoteJid || "";
  for (const block of content) {
    if (block.type !== "image") continue;
    block._hdRef = null;
    block._hdParentMessageId = parentMessageId;
    block.getHd = parentMessageId ? createHdDeferred(chatId, parentMessageId) : Promise.resolve(null);
  }
  return {
    content,
    hdParentMessageId: parentMessageId,
  };
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {Buffer} imageBuffer
 * @param {string} [caption]
 * @param {{ quoted?: BaileysMessage }} [options]
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessage | undefined>}
 */
export async function sendImageHD(sock, chatId, imageBuffer, caption, options) {
  const userJid = sock.user?.id ?? "";
  const uploadOpts = { upload: sock.waUploadToServer, userJid };

  const { default: sharp } = await import("sharp");
  const meta = await sharp(imageBuffer).metadata();
  const maxDim = Math.max(meta.width ?? 0, meta.height ?? 0);
  const sdBuffer = maxDim > 1600
    ? await sharp(imageBuffer).resize({ width: 1600, height: 1600, fit: "inside" }).jpeg({ quality: 80 }).toBuffer()
    : await sharp(imageBuffer).jpeg({ quality: 80 }).toBuffer();

  const sdMsgId = generateMessageIDV2(userJid);
  const sdMsg = await generateWAMessage(chatId, {
    image: sdBuffer,
    ...(caption && { caption }),
  }, { ...uploadOpts, messageId: sdMsgId, ...(options?.quoted && { quoted: options.quoted }) });

  if (!sdMsg.message) return undefined;

  const sdCtx = sdMsg.message.imageMessage?.contextInfo ?? {};
  sdCtx.pairedMediaType = proto.ContextInfo.PairedMediaType.SD_IMAGE_PARENT;
  if (sdMsg.message.imageMessage) sdMsg.message.imageMessage.contextInfo = sdCtx;

  sdMsg.message.messageContextInfo = { messageSecret: randomBytes(32) };
  await sock.relayMessage(chatId, sdMsg.message, { messageId: sdMsgId });

  const parentMessageKey = {
    remoteJid: sdMsg.key.remoteJid,
    fromMe: sdMsg.key.fromMe,
    id: sdMsg.key.id,
  };

  const hdMsgId = generateMessageIDV2(userJid);
  const hdMsg = await generateWAMessage(chatId, {
    image: imageBuffer,
    ...(caption && { caption }),
  }, { ...uploadOpts, messageId: hdMsgId });

  if (!hdMsg.message) return undefined;

  const hdCtx = hdMsg.message.imageMessage?.contextInfo ?? {};
  hdCtx.pairedMediaType = proto.ContextInfo.PairedMediaType.HD_IMAGE_CHILD;
  if (hdMsg.message.imageMessage) hdMsg.message.imageMessage.contextInfo = hdCtx;

  hdMsg.message.messageContextInfo = {
    messageSecret: randomBytes(32),
    messageAssociation: {
      associationType: proto.MessageAssociation.AssociationType.HD_IMAGE_DUAL_UPLOAD,
      parentMessageKey,
    },
  };

  await sock.relayMessage(chatId, hdMsg.message, { messageId: hdMsgId });

  return sdMsg;
}
