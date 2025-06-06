/**
 * WhatsApp LLM Bot with JavaScript execution capabilities
 */

import whatsapp from 'whatsapp-web.js';
const { Client, LocalAuth } = whatsapp;
import { exec } from 'child_process';
import { PGlite } from '@electric-sql/pglite';
import OpenAI from 'openai';
import { getActions, executeAction } from './actions.js';
import config from './config.js';

// Initialize database
const db = new PGlite('./pgdata');

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
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
}

/**
 * SQL template literal function (using PGlite)
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {Promise<any[]>}
 */
const sql = async (strings, ...values) => {
    const result = await db.sql(strings, ...values);
    return result.rows;
};

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: 'chromium',
    },
});

// Event listener for QR code
client.on('qr', (qr) => {
    exec(`echo "${qr}" | qrencode -t ansiutf8`, (error, stdout, stderr) => {
        if (error) {
            console.error(error);
            console.error(stderr);
            return;
        }
        console.log(stdout);
    })
});

client.on('ready', () => {
    console.log('Client is ready');
});

client.on('authenticated', (session) => {
    console.log('Client is authenticated');
});

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
 * @param {WhatsAppMessage} message
 * @param {string} selfId
 * @param {boolean} isGroup
 * @returns {Promise<boolean>}
 */
async function shouldRespond(message, selfId, isGroup) {
    const chatId = message.from;

    // Check if chat is enabled
    const [chatInfo] = await sql`SELECT is_enabled FROM chats WHERE chat_id = ${chatId}`;
    if (!chatInfo?.is_enabled) {
        return false;
    }

    // Respond to all messages in private chats
    if (!isGroup) {
        return true;
    }

    // Respond if I have been mentioned
    if (message.mentionedIds.some(contactId => String(contactId).startsWith(selfId))) {
        return true;
    }

    return false;
}

/**
 * Replace mentions with names in message
 * @param {WhatsAppMessage} message
 * @returns {Promise<string>}
 */
async function replaceMentionsWithNames(message) {
    let modifiedMessage = message.body;
    const mentionedContacts = await message.getMentions();

    for (const contact of mentionedContacts) {
        const contactId = contact.id.user;
        const contactName = contact.pushname || contact.name || contactId;
        const mentionPattern = new RegExp(`@${contactId}`, 'g');
        modifiedMessage = modifiedMessage.replace(mentionPattern, `@${contactName}`);
    }

    return modifiedMessage;
}

/**
 * Build action context for execution
 * @param {import('whatsapp-web.js').Chat} chat
 * @param {string} chatId
 */
async function buildActionContext(chat, chatId) {
    return {
        log: async (...args) => {
            const logMessage = 'Action Log:' + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join('');
            console.log(logMessage);
            await chat.sendMessage(logMessage);
            return logMessage;
        },
        chatId,
        sendMessage: chat.sendMessage.bind(chat),
        sql
    };
}

// Main message handler
client.on('message', async (message) => {
    if (!message.body) return;

    console.log('MESSAGE RECEIVED:', message.body);
    const chat = await message.getChat();

    if (message.body.startsWith('!')) {
        const [rawCommand, ...args] = message.body.slice(1).split(' ');
        const command = rawCommand.toLowerCase();
        
        const action = actionsByCommand.get(command);
        
        if (!action) {
            message.reply(`Unknown command: ${command}`);
            return;
        }

        console.log("executing", action.name, args);
        
        try {
            const context = await buildActionContext(chat, message.from);
            const result = await executeAction(action.name, context, { args });
            
            if (result && result.result && typeof result.result === 'string') {
                await message.reply(result.result);
            }
        } catch (error) {
            console.error("Error executing command:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            await message.reply(`Error: ${errorMessage}`);
        }
        
        return;
    }

    const contact = await message.getContact();
    const senderName = contact.pushname || contact.name || contact.id.user;

    const selfId = client.info.wid.user;
    const selfName = client.info?.pushname || /** @type {any} */ (client.info)?.name || selfId;

    const chatId = message.from;
    const time = new Date(message.timestamp * 1000).toLocaleString('en-EN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    // Insert chatId into DB if not already present
    await sql`INSERT INTO chats(chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING;`;

    let messageBody_formatted;
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
- context.sql: Database access with \`sql("SELECT ...")\` for read-only queries  
- context.chatId: Current WhatsApp chat ID
- context.sendMessage: Function to send additional messages to the chat

Example of correct code:
\`\`\`javascript
async ({log, sql, chatId, sendMessage}) => {
  await log('Analyzing chat activity...');
  const messages = await sql("SELECT COUNT(*) as count FROM messages WHERE chat_id = $1", chatId);
  const result = \`This chat has \${messages[0].count} messages\`;
  log('Analysis complete');
  return result;
}
\`\`\`

This format is strictly required for all JavaScript code execution.

Additional context: ${config.system_prompt}

You are in a WhatsApp chat, so use emojis and WhatsApp formatting to enhance readability.`;
    
    if (chat.isGroup) {
        // Handle quoted messages
        if (message.hasQuotedMsg) {
            const quotedMsg = await message.getQuotedMessage();
            const quotedContact = await quotedMsg.getContact();
            const quotedSenderName = quotedContact.pushname || quotedContact.name || quotedContact.id.user;
            const quotedTime = new Date(quotedMsg.timestamp * 1000).toLocaleString('en-EN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
            messageBody_formatted = `> [${quotedTime}] ${quotedSenderName}: ${quotedMsg.body.trim().replace("\n", "\n>")}\n`;
        } else {
            messageBody_formatted = '';
        }

        // Remove mention of self from start of message
        const mentionPattern = new RegExp(`^@${selfId} *`, 'g');
        message.body = message.body.replace(mentionPattern, '');

        const modifiedMessage = await replaceMentionsWithNames(message);
        messageBody_formatted += `[${time}] ${senderName}: ${modifiedMessage}`;
        systemPrompt += ` and you are in a group chat called "${chat.name}"`;
    } else {
        messageBody_formatted = `[${time}] ${await replaceMentionsWithNames(message)}`;
    }

    console.log({ messageBody_formatted });

    // Insert message into DB
    await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${messageBody_formatted}, ${contact.id.user});`;

    // Check if should respond
    if (!await shouldRespond(message, selfId, chat.isGroup)) {
        return;
    }

    // Get latest messages from DB
    const chatMessages = /** @type {Array<{ message: string, sender_id: string }>} */ (await sql`SELECT message, sender_id FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT 20;`);

    // Prepare messages for OpenAI
    const chatMessages_formatted = chatMessages.filter(x => x.message).map(({ message, sender_id }) => {
        return /** @type {import('openai/resources/index.js').ChatCompletionMessageParam} */ ({
            role: sender_id === selfId ? 'assistant' : 'user',
            name: sender_id,
            content: message,
        })
    }).reverse();

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
        message.reply('An error occurred while processing the message.\n\n' + errorMessage);
        return;
    }

    console.log("response", JSON.stringify(response, null, 2));

    const responseMessage = response.choices[0].message;

    if (responseMessage.content) {
        await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${responseMessage.content}, ${selfId});`;
        console.log('RESPONSE SENT:', responseMessage.content);
        message.reply(responseMessage.content);
    }

    if (responseMessage.tool_calls) {
        for (const toolCall of responseMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);
            console.log("executing", toolName, toolArgs);
            
            try {
                const context = await buildActionContext(chat, chatId);
                const functionResponse = await executeAction(toolName, context, toolArgs);
                console.log("response", functionResponse);

                await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${JSON.stringify(functionResponse.result)}, ${selfId});`;
                chat.sendMessage(JSON.stringify(functionResponse.result));
            } catch (error) {
                console.error("Error executing tool:", error);
                const errorMessage = `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
                await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${errorMessage}, ${selfId});`;
                chat.sendMessage(errorMessage);
            }
        }
    }
});

async function cleanup() {
    console.log('Cleaning up resources...');
    await client.destroy();
    console.log('Client closed. Closing database...');
    await db.close();
    console.log('Client and database closed');
}

// Initialize everything
try {
    await initDatabase();
    console.log('Database initialized');
    client.initialize();
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
