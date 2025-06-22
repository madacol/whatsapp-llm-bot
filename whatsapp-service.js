/**
 * WhatsApp Service - High-level abstraction over Baileys
 * Provides message-scoped APIs for easier migration to other WhatsApp clients
 */

import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { exec } from 'child_process';

// Module state
/** @type {import('@whiskeysockets/baileys').WASocket | null} */
let sock = null;
/** @type {string | null} */
let selfId = null;
/** @type {Function | null} */
let messageHandler = null;

/**
 * Internal method to process incoming messages and create enriched context
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} baileysMessage - Raw Baileys message
 */
async function _handleIncomingMessage(baileysMessage) {
    // Extract message content from Baileys format
    const messageContent = baileysMessage.message?.conversation || 
                          baileysMessage.message?.extendedTextMessage?.text || 
                          baileysMessage.message?.imageMessage?.caption ||
                          baileysMessage.message?.videoMessage?.caption || '';

    if (!messageContent) return;

    const chatId = baileysMessage.key.remoteJid;
    const senderId = baileysMessage.key.participant || baileysMessage.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');

    // Create timestamp
    let unixTime_ms;
    if (typeof baileysMessage.messageTimestamp === 'number') {
        unixTime_ms = baileysMessage.messageTimestamp * 1000;
    } else {
        unixTime_ms = baileysMessage.messageTimestamp.toNumber() * 1000;
    }
    const timestamp = new Date(unixTime_ms);

    /** @type {WhatsAppMessageContext} */
    const messageContext = {
        // Message data
        chatId,
        senderId: senderId.split('@')[0],
        senderName: baileysMessage.pushName || senderId.split('@')[0],
        content: messageContent,
        isGroup,
        timestamp,

        // High-level actions scoped to this message
        getAdminStatus: async () => {
            if (!isGroup) return 'admin'; // In private chats, treat as admin
            try {
                const groupMetadata = await sock.groupMetadata(chatId);
                const participant = groupMetadata.participants.find(p => p.id === senderId);
                return participant?.admin || null;
            } catch (error) {
                console.error('Error checking group admin status:', error);
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

        // Raw quoted message data
        quotedMessage: baileysMessage.message?.extendedTextMessage?.contextInfo?.quotedMessage || null,
        quotedSender: baileysMessage.message?.extendedTextMessage?.contextInfo?.participant || null,

        // Raw mention data
        mentions: baileysMessage.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    };

    // Call the user-provided message handler with enriched context
    if (messageHandler) {
        await messageHandler(messageContext);
    }
}

/**
 * Initialize WhatsApp connection and set up message handling
 * @param {(message: WhatsAppMessageContext) => Promise<void>} onMessageHandler - Handler function that receives enriched message context
 */
export async function connectToWhatsApp(onMessageHandler) {
    messageHandler = onMessageHandler;

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        browser: ['WhatsApp LLM Bot', 'Chrome', '1.0.0']
    });

    sock.ev.process(
        async (events) => {
            if (events['connection.update']) {
                const update = events['connection.update'];
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

                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.message !== 'logged out';
                    console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
                    if (shouldReconnect) {
                        await connectToWhatsApp(onMessageHandler);
                    }
                } else if (connection === 'open') {
                    console.log('WhatsApp connection opened');
                    selfId = sock.user?.id?.split(':')[0] || sock.user?.id;
                    console.log('Self ID:', selfId);
                }
            }

            if (events['creds.update']) {
                await saveCreds();
            }

            if (events['messages.upsert']) {
                const { messages } = events['messages.upsert'];
                for (const message of messages) {
                    if (message.key.fromMe || !message.message) continue;
                    await _handleIncomingMessage(message);
                }
            }
        }
    );
}

/**
 * Clean disconnect and cleanup
 */
export async function closeWhatsapp() {
    console.log('Cleaning up WhatsApp connection...');
    try { 
        if (sock) {
            sock.end(undefined);
        }
    } catch (error) {
        console.error('Error during WhatsApp cleanup:', error);
    }
    sock = null;
    selfId = null;
    messageHandler = null;
}