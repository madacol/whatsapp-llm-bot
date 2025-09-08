/**
 * WhatsApp Service - High-level abstraction over Baileys
 * Provides message-scoped APIs for easier migration to other WhatsApp clients
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { exec } from "child_process";


// Module state
/** @type {import('@whiskeysockets/baileys').WASocket | null} */
let sock = null;
/** @type {string | null} */
let selfId = null;
/** @type {Function | null} */
let messageHandler = null;

/**
 *
 * @param {BaileysMessage} baileysMessage
 * @returns {Promise<ContentBlock[]>}
 */
async function getMessageContent(baileysMessage) {
  /** @type {ContentBlock[]} */
  const content = [];

  // Check for quoted message content
  const quotedMessage =
    baileysMessage.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quotedMessage) {
    const quoteText =
      quotedMessage.conversation ||
      quotedMessage.extendedTextMessage?.text ||
      quotedMessage.imageMessage?.caption ||
      quotedMessage.videoMessage?.caption ||
      "";

    // const quotedSenderId = baileysMessage.message?.extendedTextMessage?.contextInfo?.participant;

    if (quoteText) {
      content.push({
        type: "quote",
        text: quoteText,
      });
    }
  }

  // Check for image content (including quoted images)
  const imageMessage = baileysMessage.message?.imageMessage;
  const videoMessage = baileysMessage.message?.videoMessage;

  if (imageMessage) {
    // Handle image message
    const imageBuffer = await downloadMediaMessage(
      baileysMessage,
      "buffer",
      {},
    );
    const base64Data = imageBuffer.toString("base64");
    const mimeType = imageMessage.mimetype || "image/jpeg";

    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: base64Data,
      },
    });
    if (imageMessage.caption) {
      content.push({
        type: "text",
        text: imageMessage.caption,
      });
    }
  } else if (videoMessage) {
    // Handle video message
    const videoBuffer = await downloadMediaMessage(
      baileysMessage,
      "buffer",
      {},
    );
    const base64Data = videoBuffer.toString("base64");
    const mimeType = videoMessage.mimetype || "video/mp4";

    content.push({
      type: "video",
      source: {
        type: "base64",
        media_type: mimeType,
        data: base64Data,
      },
    });
    if (videoMessage.caption) {
      content.push({
        type: "text",
        text: videoMessage.caption,
      });
    }
  } else {
    const messageContent =
      baileysMessage.message?.conversation ||
      baileysMessage.message?.extendedTextMessage?.text

    // Handle text message
    content.push({
      type: "text",
      text: messageContent,
    });
  }

  return content;
}

/**
 * Internal method to process incoming messages and create enriched context
 * @param {BaileysMessage} baileysMessage - Raw Baileys message
 */
async function _handleIncomingMessage(baileysMessage) {
  // Extract message content from Baileys format
  // Ignore status updates
  if (baileysMessage.key.remoteJid === "status@broadcast") {
    return;
  }

  const content = await getMessageContent(baileysMessage);

  const chatId = baileysMessage.key.remoteJid;
  const senderId = baileysMessage.key.participant || chatId;
  const isGroup = chatId.endsWith("@g.us");

  // Create timestamp
  let unixTime_ms;
  if (typeof baileysMessage.messageTimestamp === "number") {
    unixTime_ms = baileysMessage.messageTimestamp * 1000;
  } else {
    unixTime_ms = baileysMessage.messageTimestamp.toNumber() * 1000;
  }
  const timestamp = new Date(unixTime_ms);

  /** @type {MessageContext} */
  const messageContext = {
    // Message data
    chatId,
    senderId: senderId.split("@")[0],
    senderName: baileysMessage.pushName || senderId.split("@")[0],
    content: content,
    isGroup,
    timestamp,

    // High-level actions scoped to this message
    getAdminStatus: async () => {
      if (!isGroup) return "admin"; // In private chats, treat as admin
      try {
        const groupMetadata = await sock.groupMetadata(chatId);
        const participant = groupMetadata.participants.find(
          (p) => p.id === senderId,
        );
        return participant?.admin || null;
      } catch (error) {
        console.error("Error checking group admin status:", error);
        return null;
      }
    },

    sendMessage: async (text) => {
      await sock.sendMessage(chatId, { text });
    },

    replyToMessage: async (text) => {
      await sock.sendMessage(chatId, { text }, { quoted: baileysMessage });
    },

    // Bot info
    selfId,
    selfName: sock.user?.name || selfId,

    // Raw mention data
    mentions:
      baileysMessage.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
      [],
  };

  // Call the user-provided message handler with enriched context
  if (messageHandler) {
    await messageHandler(messageContext);
  }
}

/**
 * Initialize WhatsApp connection and set up message handling
 * @param {(message: MessageContext) => Promise<void>} onMessageHandler - Handler function that receives enriched message context
 */
export async function connectToWhatsApp(onMessageHandler) {
  messageHandler = onMessageHandler;

  const { state, saveCreds } = await useMultiFileAuthState(
    "./auth_info_baileys",
  );

  sock = makeWASocket({
    auth: state,
    browser: ["WhatsApp LLM Bot", "Chrome", "1.0.0"],
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        exec(`echo "${qr}" | qrencode -t ansiutf8`, (error, stdout, stderr) => {
          if (error) {
            console.error(error);
            console.error(stderr);
            return;
          }
          console.log(stdout);
        });
      }

      if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.message !== "logged out";
        console.log(
          "Connection closed due to ",
          lastDisconnect?.error,
          ", reconnecting ",
          shouldReconnect,
        );
        if (shouldReconnect) {
          await connectToWhatsApp(onMessageHandler);
        }
      } else if (connection === "open") {
        console.log("WhatsApp connection opened");
        selfId = sock.user?.id?.split(":")[0] || sock.user?.id;
        console.log("Self ID:", selfId);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
    }

    if (events["messages.upsert"]) {
      const { messages } = events["messages.upsert"];
      for (const message of messages) {
        if (message.key.fromMe || !message.message) continue;
        await _handleIncomingMessage(message);
      }
    }
  });
}

/**
 * Clean disconnect and cleanup
 */
export async function closeWhatsapp() {
  console.log("Cleaning up WhatsApp connection...");
  try {
    if (sock) {
      sock.end(undefined);
    }
  } catch (error) {
    console.error("Error during WhatsApp cleanup:", error);
  }
  sock = null;
  selfId = null;
  messageHandler = null;
}
