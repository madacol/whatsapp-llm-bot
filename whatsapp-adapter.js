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
import { handleMessage } from "./index.js";

/**
 *
 * @param {BaileysMessage} baileysMessage
 * @returns {Promise<IncomingContentBlock[]>}
 */
export async function getMessageContent(baileysMessage) {
  /** @type {IncomingContentBlock[]} */
  const content = [];

  // Check for quoted message content
  const quotedMessage = baileysMessage.message?.extendedTextMessage?.contextInfo?.quotedMessage
    || baileysMessage.message?.imageMessage?.contextInfo?.quotedMessage
    || baileysMessage.message?.videoMessage?.contextInfo?.quotedMessage
    || baileysMessage.message?.documentMessage?.contextInfo?.quotedMessage
    || baileysMessage.message?.audioMessage?.contextInfo?.quotedMessage
    || baileysMessage.message?.stickerMessage?.contextInfo?.quotedMessage;

  if (quotedMessage) {
    const quoteText = quotedMessage.conversation
      || quotedMessage.extendedTextMessage?.text
      || quotedMessage.imageMessage?.caption
      || quotedMessage.videoMessage?.caption
      || quotedMessage.documentMessage?.caption


    // const quotedSenderId = baileysMessage.message?.extendedTextMessage?.contextInfo?.participant;

    /** @type {QuoteContentBlock} */
    const quote = {
      type: "quote",
      content: [],
    };

    // if (quotedMessage.imageMessage) {
    //   quote.content.push(
    //     /** @type {ImageContentBlock} */
    //     ({
    //       type: "image",
    //       encoding: "base64",
    //       mime_type: quotedMessage.imageMessage.mimetype,
    //       data: Buffer.from(quotedMessage.imageMessage.jpegThumbnail).toString('base64')
    //     })
    //   )
    // }

    if (quoteText) {
      quote.content.push(
        /** @type {TextContentBlock} */
        ({
          type: "text",
          text: quoteText,
        })
      )
    }

    if (quote.content.length > 0) {
      content.push(quote);
    }
  }

  // Check for image content (including quoted images)
  const imageMessage = baileysMessage.message?.imageMessage;
  const videoMessage = baileysMessage.message?.videoMessage;
  const audioMessage = baileysMessage.message?.audioMessage;
  const textMessage = baileysMessage.message?.conversation
    || baileysMessage.message?.extendedTextMessage?.text
    || baileysMessage.message?.documentMessage?.caption

  if (imageMessage) {
    // Handle image message
    const imageBuffer = await downloadMediaMessage(
      baileysMessage,
      "buffer",
      {},
    );
    const base64Data = imageBuffer.toString("base64");
    const mimetype = imageMessage.mimetype;

    if (mimetype) {
      content.push({
        type: "image",
        encoding: "base64",
        mime_type: mimetype,
        data: base64Data,
      });
    } else {
      content.push({
        type: "text",
        text: "Error reading image: No mimetype found",
      });
    }
    if (imageMessage.caption) {
      content.push({
        type: "text",
        text: imageMessage.caption,
      });
    }
  }

  if (videoMessage) {
    // Handle video message
    const videoBuffer = await downloadMediaMessage(
      baileysMessage,
      "buffer",
      {},
    );
    const base64Data = videoBuffer.toString("base64");
    const mimetype = videoMessage.mimetype;

    content.push({
      type: "video",
      encoding: "base64",
      mime_type: mimetype || undefined,
      data: base64Data,
    });
    if (videoMessage.caption) {
      content.push({
        type: "text",
        text: videoMessage.caption,
      });
    }
  }

  if (audioMessage) {
    // Handle audio message
    const audioBuffer = await downloadMediaMessage(
      baileysMessage,
      "buffer",
      {},
    );
    const base64Data = audioBuffer.toString("base64");
    const mimetype = audioMessage.mimetype;

    content.push({
      type: "audio",
      encoding: "base64",
      mime_type: mimetype || undefined,
      data: base64Data,
    });
  }

  if (textMessage) {
    // Handle text message
    content.push({
      type: "text",
      text: textMessage,
    });
  }

  if (content.length === 0) {
    console.log("Unknown baileysMessage", JSON.stringify(baileysMessage, null, 2));
  }

  return content;
}

/**
 * Internal method to process incoming messages and create enriched context
 * @param {BaileysMessage} baileysMessage - Raw Baileys message
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 */
async function adaptIncomingMessage(baileysMessage, sock) {
  // Extract message content from Baileys format
  // Ignore status updates
  if (baileysMessage.key.remoteJid === "status@broadcast") {
    return;
  }

  const content = await getMessageContent(baileysMessage);

  if (content.length === 0) {
    return
  }

  const chatId = baileysMessage.key.remoteJid || "";
  /** @type {string[]} */
  const senderIds = []
  senderIds.push(baileysMessage.key.participant || baileysMessage.key.remoteJid || "unknown")
  senderIds.push( // @ts-ignore
    baileysMessage.key.participantLid // @ts-ignore
    || baileysMessage.key.participantPid // @ts-ignore
    || baileysMessage.key.senderLid // @ts-ignore
    || baileysMessage.key.senderPid // @ts-ignore
    || "unknown"
  )

  const isGroup = !!chatId?.endsWith("@g.us");

  // Create timestamp
  const timestamp =
    (typeof baileysMessage.messageTimestamp === "number")
      ? new Date(baileysMessage.messageTimestamp * 1000)
      : (!baileysMessage.messageTimestamp)
        ? new Date()
        : new Date(baileysMessage.messageTimestamp.toNumber() * 1000);


  /** @type {string[]} */
  const selfIds = [];
  {
    const lid = sock.user?.lid?.split(":")[0] || sock.user?.lid;
    const id = sock.user?.id?.split(":")[0] || sock.user?.id;
    if (id) selfIds.push(id);
    if (lid) selfIds.push(lid);
  }

  /** @type {IncomingContext} */
  const messageContext = {
    // Message data
    chatId,
    senderIds: senderIds.map(id => id.split("@")[0]),
    senderName: baileysMessage.pushName || "",
    content: content,
    isGroup,
    timestamp,

    // High-level actions scoped to this message
    getAdminStatus: async () => {
      if (!isGroup) return "admin"; // In private chats, treat as admin
      try {
        const groupMetadata = await sock.groupMetadata(chatId);
        const participant = groupMetadata.participants.find(
          participant => senderIds.includes(participant.id)
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

    confirm: async (message) => {
      const sentMsg = await sock.sendMessage(chatId, { text: message });
      if (!sentMsg) return false;

      const msgKey = sentMsg.key;
      const countdownEmojis = ["🔟", "9️⃣", "8️⃣", "7️⃣", "6️⃣", "5️⃣", "4️⃣", "3️⃣", "2️⃣", "1️⃣"];
      const intervalMs = 6_000; // 60s / 10 steps

      return new Promise((resolve) => {
        let step = 0;

        // Start with first countdown emoji
        sock.sendMessage(chatId, {
          react: { text: countdownEmojis[0], key: msgKey },
        });

        const countdown = setInterval(() => {
          step++;
          if (step >= countdownEmojis.length) {
            clearInterval(countdown);
            sock.ev.off("messages.reaction", handler);
            sock.sendMessage(chatId, {
              react: { text: "❌", key: msgKey },
            });
            resolve(false);
            return;
          }
          sock.sendMessage(chatId, {
            react: { text: countdownEmojis[step], key: msgKey },
          });
        }, intervalMs);

        /** @param {any[]} reactions */
        function handler(reactions) {
          for (const { key, reaction } of reactions) {
            if (key.id === msgKey.id && key.remoteJid === chatId) {
              if (reaction.text?.startsWith("👍")) {
                clearInterval(countdown);
                sock.ev.off("messages.reaction", handler);
                sock.sendMessage(chatId, {
                  react: { text: "✅", key: msgKey },
                });
                resolve(true);
              } else if (reaction.text?.startsWith("👎")) {
                clearInterval(countdown);
                sock.ev.off("messages.reaction", handler);
                sock.sendMessage(chatId, {
                  react: { text: "❌", key: msgKey },
                });
                resolve(false);
              }
            }
          }
        }

        sock.ev.on("messages.reaction", handler);
      });
    },

    // Bot info
    selfIds: selfIds || [],
    selfName: sock.user?.name || "",
  };

  // Call the user-provided message handler with enriched context
  await handleMessage(messageContext);
}

/**
 * Initialize WhatsApp connection and set up message handling
 * @param {(message: IncomingContext) => Promise<void>} onMessageHandler - Handler function that receives enriched message context
 */
export async function connectToWhatsApp(onMessageHandler) {

  const { state, saveCreds } = await useMultiFileAuthState(
    "./auth_info_baileys",
  );

  const sock = makeWASocket({
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
          // Clean up current socket before reconnecting to prevent memory leaks
          sock.end(undefined);

          await new Promise(resolve => setTimeout(resolve, 1000));
          await connectToWhatsApp(onMessageHandler);
        }
      } else if (connection === "open") {
        console.log("WhatsApp connection opened");
        const lid = sock.user?.lid?.split(":")[0] || sock.user?.lid;
        const id = sock.user?.id?.split(":")[0] || sock.user?.id;
        const selfIds = [];
        if (id) selfIds.push(id);
        if (lid) selfIds.push(lid);
        console.log("Self IDs:", selfIds, JSON.stringify(sock.user, null, 2));
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
    }

    if (events["messages.upsert"]) {
      const { messages } = events["messages.upsert"];
      for (const message of messages) {
        if (message.key.fromMe || !message.message) continue;
        await adaptIncomingMessage(message, sock);
      }
    }
  });

  return {
    async closeWhatsapp() {
      console.log("Cleaning up WhatsApp connection...");
      try {
        if (sock) {
          sock.end(undefined);
        }
      } catch (error) {
        console.error("Error during WhatsApp cleanup:", error);
      }
    }
  }
}
