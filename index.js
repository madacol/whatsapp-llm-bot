/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import OpenAI from 'openai';
import { getActions, executeAction } from './actions.js';
import config from './config.js';
import { getDb } from './db.js';
import { readFile } from 'fs/promises';
import { shortenToolId } from './utils.js';
import { connectToWhatsApp, closeWhatsapp } from './whatsapp-service.js';

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

// WhatsApp service will be initialized via function call

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
 * @param {WhatsAppMessageContext} messageContext
 * @returns {Promise<boolean>}
 */
async function shouldRespond(messageContext) {
    const { chatId, isGroup, selfId, mentions } = messageContext;

    // Check if chat is enabled
    const {rows: [chatInfo]} = await db.sql`SELECT is_enabled FROM chats WHERE chat_id = ${chatId}`;
    if (!chatInfo?.is_enabled) {
        return false;
    }

    // Respond to all messages in private chats
    if (!isGroup) {
        return true;
    }

    // Respond if I have been mentioned
    const isMentioned = mentions.some(contactId => String(contactId).startsWith(selfId));
    if (isMentioned) {
        return true;
    }

    return false;
}

/**
 * Replace mentions with names in message
 * @param {WhatsAppMessageContext} messageContext
 * @returns {Promise<string>}
 */
async function replaceMentionsWithNames(messageContext) {
    const { content, mentions } = messageContext;
    
    let modifiedMessage = content;
    
    for (const mentionedJid of mentions) {
        const contactId = mentionedJid.split('@')[0];
        // For now, just use the contact ID as the name since we don't have contact info
        const mentionPattern = new RegExp(`@${contactId}`, 'g');
        modifiedMessage = modifiedMessage.replace(mentionPattern, `@${contactId}`);
    }

    return modifiedMessage;
}

async function cleanup() {
    console.log('Cleaning up resources...');
    try {
        await closeWhatsapp();
    } catch (error) {
        console.error('Error during WhatsApp cleanup:', error);
    }
    console.log('WhatsApp service closed. Closing database...');
    await db.close();
    console.log('WhatsApp service and database closed');
}

/**
 * Handle incoming WhatsApp messages
 * @param {WhatsAppMessageContext} messageContext
 * @returns {Promise<void>}
 */
async function handleMessage (messageContext) {
    const { chatId, senderId, content, isGroup, senderName } = messageContext;
    
    console.log('MESSAGE RECEIVED:', content);

    // Create legacy context for actions (maintains backward compatibility)
    /** @type {Context} */
    const context = {
        chatId: chatId,
        senderId: senderId,
        content: content,
        isAdmin: await (async () => {
            const adminStatus = await messageContext.getAdminStatus();
            return adminStatus === 'admin' || adminStatus === 'superadmin';
        })(),
        sendMessage: async (header, text) => {
            const fullMessage = `${header}\n\n${text}`;
            await messageContext.sendMessage(fullMessage);
        },
        reply: async (header, text) => {
            const fullMessage = `${header}\n\n${text}`;
            await messageContext.replyToMessage(fullMessage);
        },
    };

    if (content.startsWith('!')) {
        const [rawCommand, ...args] = content.slice(1).split(' ');
        const command = rawCommand.toLowerCase();
        
        const action = actionsByCommand.get(command);
        
        if (!action) {
            await context.reply("❌ *Error*", `Unknown command: ${command}`);
            return;
        }

        console.log("executing", action.name, args);
        
        try {
            const result = await executeAction(action.name, context, { args });
            
            if (result && result.result && typeof result.result === 'string') {
                await context.reply(`⚡ *Command* !${command}`, result.result);
            }
        } catch (error) {
            console.error("Error executing command:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            await context.reply("❌ *Error*", `Error: ${errorMessage}`);
        }
        
        return;
    }

    // Use data from message context
    const selfName = messageContext.selfName;
    const time = messageContext.timestamp.toLocaleString('en-EN', {
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
- context.sendMessage: Function to send additional messages to the chat
- Anything returned from the function will be sent as a reply to the user

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
        // Handle quoted messages with business logic
        if (messageContext.quotedMessage) {
            const quotedContent = messageContext.quotedMessage.conversation || 
                                messageContext.quotedMessage.extendedTextMessage?.text || 
                                messageContext.quotedMessage.imageMessage?.caption || '';
            const quotedSender = messageContext.quotedSender?.split('@')[0] || 'Unknown';
            const quotedTime = new Date((typeof messageContext.timestamp === 'object' ? messageContext.timestamp.getTime() : messageContext.timestamp) - 1000).toLocaleString('en-EN', {
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
        const mentionPattern = new RegExp(`^@${messageContext.selfId} *`, 'g');
        const cleanedContent = content.replace(mentionPattern, '');

        // TODO: Implement mention replacement using mentions
        // const mentions = messageContext.mentions;
        messageBody_formatted += `[${time}] ${senderName}: ${cleanedContent}`;
        // TODO: Get group chat name from high-level API
        systemPrompt += ` and you are in a group chat`;
    } else {
        // TODO: Implement mention replacement using mentions
        messageBody_formatted = `[${time}] ${content}`;
    }

    console.log({ messageBody_formatted });

    // Insert message into DB
    await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type) VALUES (${chatId}, ${messageBody_formatted}, ${senderId}, 'user');`;

    // Check if should respond
    if (!await shouldRespond(messageContext)) {
        return;
    }

    // Get latest messages from DB
    const {rows: chatMessages} = /** @type {{rows: Array<{ message: string, sender_id: string, message_type: string, tool_call_id: string, tool_name: string, tool_args: string }>}} */ (await db.sql`SELECT message, sender_id, message_type, tool_call_id, tool_name, tool_args FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT 50;`);

    // Prepare messages for OpenAI (reconstruct proper format with tool calls)
    /** @type {Array<import('openai/resources/index.js').ChatCompletionMessageParam>} */
    const chatMessages_formatted = [];
    const reversedMessages = chatMessages.reverse();

    // remove starting tool results from the messages
    while (reversedMessages[0]?.message_type === 'tool_result') {
        reversedMessages.shift();
    }
    
    for (const msg of reversedMessages) {
        switch (msg.message_type) {
            case 'user':
                chatMessages_formatted.push({
                    role: 'user',
                    name: msg.sender_id,
                    content: msg.message,
                });
                break;
            case 'assistant':
                chatMessages_formatted.push({
                    role: 'assistant',
                    content: msg.message,
                });
                break;
            case 'tool_call': {
                // Find the corresponding assistant message and add tool_calls to it
                const lastMessage = chatMessages_formatted.at(-1);
                if (lastMessage?.role === 'assistant') {
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
                    chatMessages_formatted.push({
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
                    });
                }
                break;
            }
            case 'tool_result':
                chatMessages_formatted.push({
                    role: 'tool',
                    tool_call_id: msg.tool_call_id,
                    content: msg.message,
                });
                break;
            // Optionally handle unknown types
            default:
                // Ignore or log unknown message types
                break;
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
        await context.reply("❌ *Error*", 'An error occurred while processing the message.\n\n' + errorMessage);
        return;
    }

    console.log("response", JSON.stringify(response, null, 2));

    const responseMessage = response.choices[0].message;

    if (responseMessage.content) {
        await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type) VALUES (${chatId}, ${responseMessage.content}, ${messageContext.selfId}, 'assistant')`;
        console.log('RESPONSE SENT:', responseMessage.content);
        await context.reply("🤖 *AI Assistant*", responseMessage.content);
    }

    if (responseMessage.tool_calls) {
        // Store tool calls in database
        for (const toolCall of responseMessage.tool_calls) {
            await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type, tool_call_id, tool_name, tool_args) VALUES (${chatId}, ${''}, ${messageContext.selfId}, 'tool_call', ${toolCall.id}, ${toolCall.function.name}, ${toolCall.function.arguments})`;

            // Show tool call to user
            const shortId = shortenToolId(toolCall.id);
            await context.sendMessage(`🔧 *Executing* ${toolCall.function.name}    [${shortId}]`, `parameters:\n\`\`\`\n${JSON.stringify(JSON.parse(toolCall.function.arguments), null, 2)}\n\`\`\``);
        }

        for (const toolCall of responseMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);
            const shortId = shortenToolId(toolCall.id);
            console.log("executing", toolName, toolArgs);
            
            try {
                const functionResponse = await executeAction(toolName, context, toolArgs, toolCall.id);
                console.log("response", functionResponse);

                if (toolName !== 'new_conversation') {
                    // Store tool result in database
                    await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type, tool_call_id) VALUES (${chatId}, ${JSON.stringify(functionResponse.result)}, ${messageContext.selfId}, 'tool_result', ${toolCall.id})`;
                }

                const resultMessage = typeof functionResponse.result === 'string' ? functionResponse.result : JSON.stringify(functionResponse.result, null, 2);
                // Show tool result to user
                await context.sendMessage(`✅ *Result*    [${shortId}]`, resultMessage);
            } catch (error) {
                console.error("Error executing tool:", error);
                const errorMessage = `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
                // Store error as tool result
                await db.sql`INSERT INTO messages(chat_id, message, sender_id, message_type, tool_call_id) VALUES (${chatId}, ${errorMessage}, ${messageContext.selfId}, 'tool_result', ${toolCall.id})`;

                // Show tool error to user
                await context.sendMessage(`❌ *Tool Error*    [${shortId}]`, errorMessage);
            }
        }
    }
}

// Initialize everything
try {
    await initDatabase();
    console.log('Database initialized');
    await connectToWhatsApp(handleMessage);
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
