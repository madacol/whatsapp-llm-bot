const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { exec, spawn } = require('child_process');
const fs = require('fs');

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./chats.db');

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// get the system prompt from environment variable
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `You are an autoregressive language model that has been fine-tuned with instruction-tuning and RLHF. You carefully provide accurate, factual, thoughtful, nuanced answers, and are brilliant at reasoning. If you think there might not be a correct answer, you say so. Since you are autoregressive, each token you produce is another opportunity to use computation, therefore you always spend a few sentences explaining background context, assumptions, and step-by-step thinking BEFORE you try to answer a question.

Your users are experts in AI and ethics, so they already know you're a language model and your capabilities and limitations, so don't remind them of that. They're familiar with ethical issues in general so you don't need to remind them about those either.`

// Initialize the database tables
db.run(/*sql*/`
    CREATE TABLE IF NOT EXISTS chats (
        chat_id varchar(20) PRIMARY KEY,
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
        headless: false,
        executablePath: '/opt/google/chrome/chrome',
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

    if (message.body.startsWith('!')) {
        const [rawCommand, ...args] = message.body.slice(1).split(' ');

        const command = rawCommand.toLowerCase();

        const action = ACTIONS_INDEXED_BY_COMMAND[command];

        if (!action) {
            message.reply(`Unknown command: ${command}`);
            return;
        }

        return action.fn(args, message);
    }

    const contact = await message.getContact();
    const senderName = contact.pushname || contact.name || contact.id.user;

    const selfId = client.info.wid.user;
    const selfName = client.info.pushname || client.info.name || selfId;

    const chat = await message.getChat();
    const chatId = message.from;
    // insert chatId into DB if not already present
    await sql`INSERT OR IGNORE INTO chats(chat_id) VALUES (${chatId});`;


    let messageBody_formatted, systemPrompt;
    if (chat.isGroup) {
        // Call shouldRespond to determine if the bot should process this message
        if (!await shouldRespond(message, selfId)) {
            return;
        }

        // Remove mention of self from start of message
        const mentionPattern = new RegExp(`^@${selfId} *`, 'g');
        message.body = message.body.replace(mentionPattern, '');

        const modifiedMessage = await replaceMentionsWithNames(message);

        // prepend name of sender to prompt
        messageBody_formatted = `${senderName}: ${modifiedMessage}`;
        systemPrompt = SYSTEM_PROMPT + `\n\nYou are a brilliant AI assistant called ${selfName}.\nYou are in a group chat called "${chat.name}"`;
    } else {
        messageBody_formatted = await replaceMentionsWithNames(message);
        systemPrompt = SYSTEM_PROMPT + `\n\nYou are a brilliant AI assistant called ${selfName}`;
    }

    // insert message into DB
    await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${messageBody_formatted}, ${contact.id.user});`;

    // obtain latest messages from DB
    const chatMessages = await sql`SELECT message, sender_id FROM messages WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT 20;`;

    // prepare messages for OpenAI
    const chatMessages_formatted = chatMessages.filter(x=>x.message).map(({message, sender_id}) => {
        return {
            role: sender_id === selfId ? 'assistant' : 'user',
            content: message,
        }
    }).reverse();

    // call OpenAI
    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{role: "system", content: systemPrompt}, ...chatMessages_formatted],
        functions: actions_openAI_formatted,
        function_call: "auto",
    });
    const responseMessage = response.choices[0].message;

    if (responseMessage.content) {
        await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${responseMessage.content}, ${selfId});`;
        message.reply(responseMessage.content);
    }

    if (responseMessage.function_call) {

        const functionName = responseMessage.function_call.name;
        const functionToCall = FUNCTIONS_INDEXED_BY_NAME[functionName];
        const functionArgs = JSON.parse(responseMessage.function_call.arguments);
        console.log("executing", functionName, functionArgs);
        const functionResponse = await functionToCall(functionArgs, message);
        console.log("response", functionResponse);

        if (functionResponse) {
            // insert into DB
            await sql`INSERT INTO messages(chat_id, message, sender_id) VALUES (${chatId}, ${functionResponse}, ${selfId});`;
            chat.sendMessage(functionResponse);
        }
    }

});

client.initialize();

async function shouldRespond (message, selfId) {

    // Respond if I have been mentioned
    if (message.mentionedIds.some(contactId => contactId.startsWith(selfId))) {
        return true;
    }

    // Respond if I have been quoted
    if (message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        const quotedContact = await quotedMsg.getContact();
        if (quotedContact.id.user === selfId) {
            return true;
        }
    }

    return false;
};

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
        name,
        description,
        parameters,
    }
})
