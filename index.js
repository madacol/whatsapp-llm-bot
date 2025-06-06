const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const config = require('./config');

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./chats.db');

const OpenAI = require('openai');
const llmClient = new OpenAI({
    apiKey: config.llm_api_key,
    baseURL: config.base_url
});

// Initialize the database tables
db.run(/*sql*/`
    CREATE TABLE IF NOT EXISTS chats (
        chat_id varchar(20) PRIMARY KEY,
        is_enabled INTEGER DEFAULT FALSE,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);
db.run(/*sql*/`
    CREATE TABLE IF NOT EXISTS messages (
        message_id INTEGER PRIMARY KEY,
        chat_id varchar(20) REFERENCES chats(chat_id),
        sender_id varchar(20),
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const sql = (strings, ...values) => new Promise((resolve, reject) => {
    const query = String.raw(strings, ...values.map(_ => '?')); // Use '?' as placeholder
    db.all(query, values, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
    });
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: 'chromium',
    },
});

// Event listener for when the QR code is received for scanning
client.on('qr', (qr) => {
    exec(`echo "${qr}" | qrencode -t ansiutf8`, (error, stdout, stderr) => {
        if (error) {
            console.error(error);
            console.error(stderr);
            return;
        }

        // Print the QR code in the terminal
        console.log(stdout);
    })
});

client.on('ready', () => {
    console.log('Client is ready');
});

client.on('authenticated', (session) => {
    console.log('Client is authenticated');
});

client.on('message', async (message) => {
    if (!message.body) return;

    // Log the received message
    console.log('MESSAGE RECEIVED:', message.body);

    if (message.body.startsWith('!')) {
        const [rawCommand, ...args] = message.body.slice(1).split(' ');

        const command = rawCommand.toLowerCase();

        const action = ACTIONS_INDEXED_BY_COMMAND[command];

        if (!action) {
            message.reply(`Unknown command: ${command}`);
            return;
        }

        console.log("executing", action.name, args);
        return await action.fn(args, message);
    }

    const contact = await message.getContact();
    const senderName = contact.pushname || contact.name || contact.id.user;

    const selfId = client.info.wid.user;
    const selfName = client.info.pushname || client.info.name || selfId;

    const chat = await message.getChat();
    const chatId = message.from;
    const time = new Date(message.timestamp*1000).toLocaleString('en-EN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    // insert chatId into DB if not already present
    await sql`INSERT OR IGNORE INTO chats(chat_id) VALUES (${chatId});`;

    let messageBody_formatted;
    let systemPrompt = config.system_prompt + `\n\nYou are an AI assistant called ${selfName}`;
    if (chat.isGroup) {
        // concatenate quoted message, if any
        if (message.hasQuotedMsg) {
            const quotedMsg = await message.getQuotedMessage();
            const quotedContact = await quotedMsg.getContact();
            const quotedSenderName = quotedContact.pushname || quotedContact.name || quotedContact.id.user;
            const quotedTime = new Date(quotedMsg.timestamp*1000).toLocaleString('en-EN', {
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

        // prepend name of sender to prompt
        messageBody_formatted += `[${time}] ${senderName}: ${modifiedMessage}`;
        systemPrompt += `and you are in a group chat called "${chat.name}"`;
    } else {
        messageBody_formatted = `[${time}] ${await replaceMentionsWithNames(message)}`;
    }

    // insert message into DB
    await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${messageBody_formatted}, ${contact.id.user});`;

    // Call shouldRespond to determine if the bot should process this message
    if (!await shouldRespond(message, selfId, chat.isGroup)) {
        return;
    }

    // obtain latest messages from DB
    const chatMessages = await sql`SELECT message, sender_id FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT 20;`;

    // prepare messages for OpenAI
    const chatMessages_formatted = chatMessages.filter(x=>x.message).map(({message, sender_id}) => {
        return {
            role: sender_id === selfId ? 'assistant' : 'user',
            content: message,
        }
    }).reverse();

    let response;
    try {
        response = await llmClient.chat.completions.create({
            model: config.model,
            messages: [{role: "system", content: systemPrompt}, ...chatMessages_formatted],
            tools: actions_openAI_formatted,
            tool_choice: "auto",
        });
    } catch (error) {
        console.error(error);
        message.reply('An error occurred while processing the message.\n\n' + error.message);
        return;
    }

    const responseMessage = response.choices[0].message;

    if (responseMessage.content) {
        await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${responseMessage.content}, ${selfId});`;
        // Log the response being sent
        console.log('RESPONSE SENT:', responseMessage.content);
        message.reply(responseMessage.content);
    }

    if (responseMessage.tool_calls) {
        for (const toolCall of responseMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);
            console.log("executing", toolName, toolArgs);
            const functionResponse = await FUNCTIONS_INDEXED_BY_NAME[toolName](toolArgs, message);
            console.log("response", functionResponse);

            if (functionResponse) {
                // insert into DB
                await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${functionResponse}, ${selfId});`;
                chat.sendMessage(functionResponse);
            }
        }
    }
});

client.initialize();

/**
 * 
 * @param {import("whatsapp-web.js").Message} message 
 * @param {string} selfId
 * @param {boolean} isGroup 
 * @returns 
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
    if (message.mentionedIds.some(contactId => contactId.startsWith(selfId))) {
        return true;
    }

    // Respond if I have been quoted
    // if (message.hasQuotedMsg) {
    //     const quotedMsg = await message.getQuotedMessage();
    //     const quotedContact = await quotedMsg.getContact();
    //     if (quotedContact.id.user === selfId) {
    //         return true;
    //     }
    // }

    return false;
}

async function replaceMentionsWithNames (message) {
    let modifiedMessage = message.body;
    const mentionedContacts = await message.getMentions();

    for (const contact of mentionedContacts) {
        const contactId = contact.id.user;
        const contactName = contact.pushname || contact.name || contactId;
        const mentionPattern = new RegExp(`@${contactId}`, 'g');
        modifiedMessage = modifiedMessage.replace(mentionPattern, `@${contactName}`);
    }

    return modifiedMessage;
};

const ACTIONS = [
    {
        name: "new_conversation",
        command: "new",
        description: "Start a new conversation by clearing message history for the current chat",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
        fn: async function (args, message) {
            const chatId = message.from;
            
            try {
                // Delete all messages for this chat
                await sql`DELETE FROM messages WHERE chat_id = ${chatId}`;
                
                // Confirm message was successful
                message.reply("Conversation history cleared. Starting a new conversation!");
            } catch (error) {
                console.error("Error clearing conversation:", error);
                message.reply("Failed to clear conversation history.\n\n" + error.message);
            }
        }
    },
    {
        name: "download_video",
        command: "video",
        description: "Download video from URL, and send it to chat",
        parameters: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "URL of the video to download",
                },
            },
            required: ["url"],
        },
        fn: function (args, message) {
            // check if args is an array
            let url;
            if (Array.isArray(args)) {
                ([url] = args);
            } else {
                // asume is an object
                ({url} = args);
            }
            return new Promise((resolve, reject) => {
                const ytdlProcess = spawn('yt-dlp', ['-o', "/dev/shm/%(title)s.%(ext)s", url]);

                ytdlProcess.on('error', (error) => {
                    console.error(`Error spawning yt-dlp: ${error}`);
                    message.reply('Failed to start the download.');
                });

                let stdoutData = '';
                ytdlProcess.stdout.on('data', (data) => {
                    const stdoutString = data.toString();
                    stdoutData += stdoutString;
                    console.log(`yt-dlp stdout: ${stdoutString}`);
                });

                ytdlProcess.stderr.on('data', (data) => {
                    console.error(`yt-dlp stderr: ${data}`);
                });

                ytdlProcess.on('close', async (code) => {
                    if (code !== 0) {
                        message.reply('Download failed.');
                        return;
                    }

                    // Extract filename from stdout data
                    const downloadedFilepath =
                        stdoutData.match(/Merging formats into "([^"]+)"/)?.at(1)
                        || stdoutData.match(/\[download\] (.+?) has already been downloaded/)?.at(1)
                        || stdoutData.match(/\[download\] Destination: (.+?)\n/)?.at(1)
                        || null;

                    const convertedFilepath = `${downloadedFilepath}.mp4`;

                    // Start FFmpeg to convert video to mp4
                    const ffmpegProcess = spawn('ffmpeg', ['-i', downloadedFilepath,
                        "-vf", "scale='bitand(oh*dar,65534)':'min(720,ih)'",
                        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                        "-c:v", "libx264",
                        "-pix_fmt", "yuv420p",
                        "-profile:v", "baseline",
                        "-level", "3.0",
                        "-y",
                        convertedFilepath
                    ]);

                    ffmpegProcess.on('error', (error) => {
                        console.error(`Error spawning FFmpeg: ${error}`);
                        message.reply('Failed to convert the video.');
                    });

                    ffmpegProcess.stdout.on('data', (data) => {
                        console.log(`FFmpeg stdout: ${data}`);
                    });

                    ffmpegProcess.stderr.on('data', (data) => {
                        console.error(`FFmpeg stderr: ${data}`);
                    });

                    ffmpegProcess.on('close', async (code) => {
                        if (code !== 0) {
                            message.reply('Conversion failed.');
                            return;
                        }

                        try {
                            const media = MessageMedia.fromFilePath(convertedFilepath);
                            await message.reply(media);
                            fs.unlinkSync(convertedFilepath);
                            // fs.unlinkSync(downloadedFilepath)
                        } catch (error) {
                            console.error(error);
                            message.reply('An error occurred while processing the video.');
                            return;
                        }

                        resolve()
                    });
                });
            });
        }
    },{
        name: "download_audio",
        command: "audio",
        description: "Download audio from URL, and send it to chat",
        parameters: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "URL of the audio to download",
                },
            },
            required: ["url"],
        },
        fn: function (args, message) {
            // check if args is an array
            let url;
            if (Array.isArray(args)) {
                ([url] = args);
            } else {
                // asume is an object
                ({url} = args);
            }
            return new Promise((resolve, reject) => {

                const ytdlProcess = spawn('yt-dlp', ['-x', '-o', "/dev/shm/%(title)s.%(ext)s",  url]);

                ytdlProcess.on('error', (error) => {
                    console.error(`Error spawning yt-dlp: ${error}`);
                    message.reply('Failed to start the download.');
                });

                let stdoutData = '';
                ytdlProcess.stdout.on('data', (data) => {
                    const stdoutString = data.toString();
                    stdoutData += stdoutString;
                    console.log(`yt-dlp stdout: ${stdoutString}`);
                });

                ytdlProcess.stderr.on('data', (data) => {
                    console.error(`yt-dlp stderr: ${data}`);
                });

                ytdlProcess.on('close', async (code) => {
                    if (code !== 0) {
                        message.reply('Download failed.');
                        return;
                    }

                    // Extract filename from stdout data
                    const downloadedFilepath =
                        stdoutData.match(/\[ExtractAudio\] Destination: (.+?)\n/)?.at(1)
                        || stdoutData.match(/Destination: (.+?)\n/)?.at(1)
                        || null;

                    console.log({ downloadedFilepath, stdoutData });

                    try {
                        const media = MessageMedia.fromFilePath(downloadedFilepath);
                        await message.reply(media);
                        // fs.unlinkSync(downloadedFilepath);
                    } catch (error) {
                        console.error(error);
                        message.reply('An error occurred while processing the audio.');
                        return;
                    }

                    resolve()
                });
            });
        }
    },
    {
        name: "show_info",
        command: "info",
        description: "Show information about the current chat",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
        fn: async function (args, message) {
            const chatId = message.from;
            
            // Get chat enabled status
            const [chatInfo] = await sql`SELECT is_enabled FROM chats WHERE chat_id = ${chatId}`;
            const isEnabled = chatInfo?.is_enabled ? 'enabled' : 'disabled';
            
            let info = `Chat Information:\n`;
            info += `- Chat ID: ${chatId}\n`;
            // info += `- Chat Name: ${chat.name || 'Private Chat'}\n`;
            // info += `- Type: ${chat.isGroup ? 'Group' : 'Private'}\n`;
            info += `- enabled: ${isEnabled}`;
            
            message.reply(info);
        }
    },{
        name: "enable_chat",
        command: "enable",
        description: "Enable LLM answers for a specific chat (admin only)",
        parameters: {
            type: "object",
            properties: {
                chatId: {
                    type: "string",
                    description: "Chat ID to enable (defaults to current chat if not provided)",
                }
            },
            required: [],
        },
        fn: async function (args, message) {
            const contact = await message.getContact();
            const senderId = contact.id.user;
            
            // Check if sender is admin
            if (senderId !== config.admin_id) {
                return message.reply("Sorry, only the admin can use this command.");
            }
            
            let chatId;
            if (Array.isArray(args)) {
                chatId = args[0] || message.from;
            } else {
                chatId = args.chatId || message.from;
            }
            
            // First check if chat exists
            const [chatExists] = await sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

            if (!chatExists) {
                return message.reply(`Chat ${chatId} does not exist.`);
            }
            // If chat exists, update its is_enabled status
            try {
                await sql`
                    UPDATE chats 
                    SET is_enabled = 1
                    WHERE chat_id = ${chatId}
                `;
                
                message.reply(`LLM answers enabled for chat ${chatId}`);
            } catch (error) {
                console.error("Error enabling chat:", error);
                message.reply("Failed to enable chat.\n\n" + error.message);
            }
        }
    },
    {
        name: "disable_chat",
        command: "disable",
        description: "Disable LLM answers for a specific chat (admin only)", 
        parameters: {
            type: "object",
            properties: {
                chatId: {
                    type: "string",
                    description: "Chat ID to disable (defaults to current chat if not provided)",
                }
            },
            required: [],
        },
        fn: async function (args, message) {
            const contact = await message.getContact();
            const senderId = contact.id.user;
            
            // Check if sender is admin
            if (senderId !== config.admin_id) {
                return message.reply("Sorry, only the admin can use this command.");
            }
            
            let chatId;
            if (Array.isArray(args)) {
                chatId = args[0] || message.from;
            } else {
                chatId = args.chatId || message.from;
            }
            
            // First check if chat exists
            const [chatExists] = await sql`SELECT chat_id FROM chats WHERE chat_id = ${chatId}`;

            if (!chatExists) {
                return message.reply(`Chat ${chatId} does not exist.`);
            }
            // If chat exists, update its is_enabled status
            try {
                await sql`
                    UPDATE chats 
                    SET is_enabled = 0
                    WHERE chat_id = ${chatId}
                `;
                
                message.reply(`LLM answers disabled for chat ${chatId}`);
            } catch (error) {
                console.error("Error disabling chat:", error);
                message.reply("Failed to disable chat.\n\n" + error.message);
            }
        }
    }
]

const FUNCTIONS_INDEXED_BY_NAME = {}
const ACTIONS_INDEXED_BY_COMMAND = {}
ACTIONS.forEach(action => {
    FUNCTIONS_INDEXED_BY_NAME[action.name] = action.fn;
    ACTIONS_INDEXED_BY_COMMAND[action.command] = action;
});

const actions_openAI_formatted = ACTIONS.map(({name, description, parameters}) => {
    return {
        type: "function",
        function: {
            name,
            description,
            parameters,
        }
    }
})
