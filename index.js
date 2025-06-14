/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { exec } from 'child_process';
import OpenAI from 'openai';
import { getActions, executeAction } from './actions.js';
import config from './config.js';
import { getDb } from './db.js';
import { readFile } from 'fs/promises';

// Initialize database
const db = getDb('./pgdata/root');

// Initialize LLM client
const llmClient = new OpenAI({
    apiKey: config.llm_api_key,
    baseURL: config.base_url
});

// Initialize database tables
async function initDatabase() {
    await db.sql`
        CREATE TABLE IF NOT EXISTS chats (
            chat_id VARCHAR(50) PRIMARY KEY,
            is_enabled BOOLEAN DEFAULT FALSE,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    await db.sql`
        CREATE TABLE IF NOT EXISTS messages (
            message_id SERIAL PRIMARY KEY,
            chat_id VARCHAR(50) REFERENCES chats(chat_id),
            sender_id VARCHAR(50),
            message TEXT,
            message_type VARCHAR(20) DEFAULT 'user',
            tool_call_id VARCHAR(100),
            tool_name VARCHAR(100),
            tool_args TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // Add new columns if they don't exist (for existing databases)
    try {
        await db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'user'`;
        await db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_call_id VARCHAR(100)`;
        await db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_name VARCHAR(100)`;
        await db.sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_args TEXT`;
    } catch (error) {
        // Ignore errors if columns already exist
        console.log('Database schema already up to date');
    }
}

// Initialize WhatsApp client
let sock;
let selfId;

async function connectToWhatsApp() {
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
                        await connectToWhatsApp();
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
                    await handleMessage(message);
                }
            }
        }
    );
}

// Load actions
/** @type {Action[]} */
let actions = [];
/** @type {Map<string, Action>} */
let actionsByCommand = new Map();

getActions().then(loadedActions => {
    actions = loadedActions;
    
    // Index actions by command
    actions.forEach(action => {
        if (action.command) {
            actionsByCommand.set(action.command, action);
        }
    });
    
    console.log(`Loaded ${actions.length} actions`);
});

/**
 * Convert actions to OpenAI tools format
 * @param {Action[]} actions
 * @returns {any[]}
 */
function actionsToOpenAIFormat(actions) {
    return actions.map(action => ({
        type: "function",
        function: {
            name: action.name,
            description: action.description,
            parameters: action.parameters
        }
    }));
}

/**
 * Check if the bot should respond to a message
 * @param {BaileysMessage} message
 * @param {string} selfId
 * @param {boolean} isGroup
 * @returns {Promise<boolean>}
 */
async function shouldRespond(message, selfId, isGroup) {
    const chatId = message.key.remoteJid;

    // Check if chat is enabled
    const {rows: [chatInfo]} = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = ${chatId}`;
    if (!chatInfo?.is_enabled) {
        return false;
    }

    // Respond to all messages in private chats
    if (!isGroup) {
        return true;
    }

    // Respond if I have been mentioned (check for mentions in Baileys format)
    const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentions.some(contactId => String(contactId).startsWith(selfId))) {
        return true;
    }

    return false;
}

/**
 * Replace mentions with names in message
 * @param {BaileysMessage} message
 * @returns {Promise<string>}
 */
async function replaceMentionsWithNames(message) {
    // Get message content from Baileys format
    const messageContent = message.message?.conversation || 
                          message.message?.extendedTextMessage?.text || '';
    
    // Get mentions from Baileys format
    const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    
    let modifiedMessage = messageContent;
    
    for (const mentionedJid of mentions) {
        const contactId = mentionedJid.split('@')[0];
        // For now, just use the contact ID as the name since we don't have contact info
        const mentionPattern = new RegExp(`@${contactId}`, 'g');
        modifiedMessage = modifiedMessage.replace(mentionPattern, `@${contactId}`);
    }

    return modifiedMessage;
}

/**
 * 
 * @param {BaileysMessage} message 
 * @returns 
 */
async function handleMessage(message) {
    // Extract message content from Baileys format
    const messageContent = message.message?.conversation || 
                          message.message?.extendedTextMessage?.text || 
                          message.message?.imageMessage?.caption ||
                          message.message?.videoMessage?.caption || '';
    
    if (!messageContent) return;

    console.log('MESSAGE RECEIVED:', messageContent);
    
    const chatId = message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');

    /** @type {ChatContext} */
    const chatContext = {
        chatId: chatId,
        sendMessage: async (msg) => {
            await sock.sendMessage(chatId, { text: msg });
        },
    }

    /** @type {MessageContext} */
    const messageContext = {
        senderId: senderId.split('@')[0],
        content: messageContent,
        isAdmin: await (async () => {
            if (!isGroup) return true;
            try {
                const groupMetadata = await sock.groupMetadata(chatId);
                const participant = groupMetadata.participants.find(p => p.id === senderId);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin';
            } catch (error) {
                console.error('Error checking group admin status:', error);
                return false;
            }
        })(),
        reply: async (msg) => {
            await sock.sendMessage(chatId, { text: msg }, { quoted: message });
        },
    }

    if (messageContent.startsWith('!')) {
        const [rawCommand, ...args] = messageContent.slice(1).split(' ');
        const command = rawCommand.toLowerCase();
        
        const action = actionsByCommand.get(command);
        
        if (!action) {
            messageContext.reply(`Unknown command: ${command}`);
            return;
        }

        console.log("executing", action.name, args);
        
        try {
            const result = await executeAction(action.name, chatContext, messageContext, { args });
            
            if (result && result.result && typeof result.result === 'string') {
                await messageContext.reply(result.result);
            }
        } catch (error) {
            console.error("Error executing command:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            await messageContext.reply(`Error: ${errorMessage}`);
        }
        
        return;
    }

    // Extract sender info from Baileys message
    const senderName = message.pushName || senderId.split('@')[0];

    // Use the global selfId
    const selfName = sock.user?.name || selfId;
    /** @type {number} */
    let unixTime_ms;
    if (typeof message.messageTimestamp === 'number') {
        unixTime_ms = message.messageTimestamp * 1000
    } else {
        unixTime_ms = message.messageTimestamp.toNumber() * 1000
    }
    const time = new Date(unixTime_ms).toLocaleString('en-EN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    // Insert chatId into DB if not already present
    await db.sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING;`;

    let messageBody_formatted;
    const typesFileContent = await readFile('./types.d.ts', {encoding: 'utf-8', flag: 'r'});
    let systemPrompt = `You are ${selfName}, a helpful AI assistant that can execute JavaScript code in a WhatsApp chat environment.
Use the \`run_javascript\` action for computational tasks, data analysis, and dynamic responses.
All JavaScript code runs on the server and has access to the chat database and context.

When asked to perform calculations, data analysis, or generate dynamic content:
1. Use \`run_javascript\` to implement and execute the solution
2. Show your work through logging and return meaningful results
3. Make responses engaging and conversational for WhatsApp

IMPORTANT JavaScript Code Requirements:
When writing JavaScript code, you MUST always use arrow functions that receive a context parameter with these properties:
- context.log: Async function to add messages visible to the user
- context.sessionDb.sql: queries a postgres database for current conversation, call it with template literals like context.sessionDb.sql\`SELECT * FROM table WHERE id = \${id}\`
- context.chat.sendMessage: Function to send additional messages to the chat

Example code:
\`\`\`javascript
async ({log, sessionDb, chat}) => {
  await log('Analyzing chat activity...');
  const {rows: messages} = await sessionDb.sql\`SELECT * FROM messages WHERE chat_id = \${chat.chatId}\`;
  const result = \`This chat has \${messages.length} messages\`;
  log('Analysis complete');

  // Send result to chat
  // chat.sendMessage(result);

  // Reply with the result
  // message.reply(result);

  // Or just return the result, which replies it by default
  return result;
}
\`\`\`

This is the currently used TypeScript type definitions for the context parameter:

\`\`\`typescript
${typesFileContent}
\`\`\`

This format is strictly required for all JavaScript code execution.

Additional context: ${config.system_prompt}
`;
    
    if (isGroup) {
        // Handle quoted messages (Baileys format)
        const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMessage) {
            const quotedContent = quotedMessage.conversation || 
                                quotedMessage.extendedTextMessage?.text || 
                                quotedMessage.imageMessage?.caption || '';
            const quotedSender = message.message?.extendedTextMessage?.contextInfo?.participant?.split('@')[0] || 'Unknown';
            const quotedTime = new Date((typeof message.messageTimestamp === 'number' ? message.messageTimestamp : message.messageTimestamp.toNumber()) * 1000).toLocaleString('en-EN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
            messageBody_formatted = `> [${quotedTime}] ${quotedSender}: ${quotedContent.trim().replace("\n", "\n>")}\n`;
        } else {
            messageBody_formatted = '';
        }

        // Remove mention of self from start of message
        const mentionPattern = new RegExp(`^@${selfId} *`, 'g');
        const cleanedContent = messageContent.replace(mentionPattern, '');

        // TODO: Implement mention replacement for Baileys
        // const modifiedMessage = await replaceMentionsWithNames(message);
        messageBody_formatted += `[${time}] ${senderName}: ${cleanedContent}`;
        // TODO: Get group chat name from Baileys
        systemPrompt += ` and you are in a group chat`;
    } else {
        // TODO: Implement mention replacement for Baileys
        messageBody_formatted = `[${time}] ${messageContent}`;
    }

    console.log({ messageBody_formatted });

    // Insert message into DB
    await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type) VALUES (${chatId}, ${messageBody_formatted}, ${senderId.split('@')[0]}, 'user');`;

    // Check if should respond
    if (!await shouldRespond(message, selfId, isGroup)) {
        return;
    }

    // Get latest messages from DB
    const {rows: chatMessages} = /** @type {{rows: Array<{ message: string, sender_id: string, message_type: string, tool_call_id: string, tool_name: string, tool_args: string }>}} */ (await db.sql`SELECT message, sender_id, message_type, tool_call_id, tool_name, tool_args FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT 50;`);

    // Prepare messages for OpenAI (reconstruct proper format with tool calls)
    /** @type {Array<import('openai/resources/index.js').ChatCompletionMessageParam>} */
    const chatMessages_formatted = [];
    const reversedMessages = chatMessages.reverse();
    
    for (const msg of reversedMessages) {
        if (msg.message_type === 'user') {
            chatMessages_formatted.push(({
                role: 'user',
                name: msg.sender_id,
                content: msg.message,
            }));
        } else if (msg.message_type === 'assistant') {
            chatMessages_formatted.push(({
                role: 'assistant',
                content: msg.message,
            }));
        } else if (msg.message_type === 'tool_call') {
            // Find the corresponding assistant message and add tool_calls to it
            const lastMessage = chatMessages_formatted[chatMessages_formatted.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
                if (!lastMessage.tool_calls) {
                    lastMessage.tool_calls = [];
                }
                lastMessage.tool_calls.push({
                    id: msg.tool_call_id,
                    type: 'function',
                    function: {
                        name: msg.tool_name,
                        arguments: msg.tool_args,
                    },
                });
            } else {
                // If no assistant message exists, create one with just tool calls
                chatMessages_formatted.push(({
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: msg.tool_call_id,
                        type: 'function',
                        function: {
                            name: msg.tool_name,
                            arguments: msg.tool_args,
                        },
                    }],
                }));
            }
        } else if (msg.message_type === 'tool_result') {
            chatMessages_formatted.push(({
                role: 'tool',
                tool_call_id: msg.tool_call_id,
                content: msg.message,
            }));
        }
    }

    console.log(chatMessages_formatted);

    let response;
    try {
        response = await llmClient.chat.completions.create({
            model: config.model || 'gpt-3.5-turbo',
            messages: [{ role: "system", content: systemPrompt }, ...chatMessages_formatted],
            tools: actionsToOpenAIFormat(actions),
            tool_choice: "auto",
        });
    } catch (error) {
        console.error(error);
        const errorMessage = JSON.stringify(error, null, 2);
        messageContext.reply('An error occurred while processing the message.\n\n' + errorMessage);
        return;
    }

    console.log("response", JSON.stringify(response, null, 2));

    const responseMessage = response.choices[0].message;

    if (responseMessage.content) {
        await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type) VALUES (${chatId}, ${responseMessage.content}, ${selfId}, 'assistant');`;
        console.log('RESPONSE SENT:', responseMessage.content);
        messageContext.reply(responseMessage.content);
    }

    if (responseMessage.tool_calls) {
        // Store tool calls in database
        for (const toolCall of responseMessage.tool_calls) {
            await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type, tool_call_id, tool_name, tool_args) VALUES (${chatId}, ${''}, ${selfId}, 'tool_call', ${toolCall.id}, ${toolCall.function.name}, ${toolCall.function.arguments});`;
        }

        for (const toolCall of responseMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);
            console.log("executing", toolName, toolArgs);
            
            try {
                const functionResponse = await executeAction(toolName, chatContext, messageContext, toolArgs);
                console.log("response", functionResponse);

                // Store tool result in database
                await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type, tool_call_id) VALUES (${chatId}, ${JSON.stringify(functionResponse.result)}, ${selfId}, 'tool_result', ${toolCall.id});`;
                chatContext.sendMessage(JSON.stringify(functionResponse.result));
            } catch (error) {
                console.error("Error executing tool:", error);
                const errorMessage = `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
                // Store error as tool result
                await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type, tool_call_id) VALUES (${chatId}, ${errorMessage}, ${selfId}, 'tool_result', ${toolCall.id});`;
                chatContext.sendMessage(errorMessage);
            }
        }
    }
}

async function cleanup() {
    console.log('Cleaning up resources...');
    try { 
        if (sock) {
            sock.end();
        }
    } catch (error) {}
    console.log('Socket closed. Closing database...');
    await db.close();
    console.log('Socket and database closed');
}

// Initialize everything
try {
    await initDatabase();
    console.log('Database initialized');
    await connectToWhatsApp();
} catch (error) {
    console.error('Initialization error:', error);
    await cleanup();
    process.exit(1);
}

process.on('SIGINT', async function() {
    await cleanup();
    process.exit(0);
});

process.on('SIGTERM', async function() {
    await cleanup();
    process.exit(0);
});
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await cleanup();
    process.exit(1);
});
