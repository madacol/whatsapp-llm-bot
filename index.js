const sqlite3 = require('sqlite3').verbose();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { exec, spawn } = require('child_process');
const fs = require('fs');

const db = new sqlite3.Database('./chats.db');

// get the system prompt from environment variable
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `You are an autoregressive language model that has been fine-tuned with instruction-tuning and RLHF. You carefully provide accurate, factual, thoughtful, nuanced answers, and are brilliant at reasoning. If you think there might not be a correct answer, you say so. Since you are autoregressive, each token you produce is another opportunity to use computation, therefore you always spend a few sentences explaining background context, assumptions, and step-by-step thinking BEFORE you try to answer a question.

Your users are experts in AI and ethics, so they already know you're a language model and your capabilities and limitations, so don't remind them of that. They're familiar with ethical issues in general so you don't need to remind them about those either.`

// Initialize the database table
db.run(/*sql*/`
    CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT,
        conversation_id TEXT,
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
            console.error(`Error executing qrencode: ${error}`);
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
        const [command, ...args] = message.body.slice(1).split(' ');

        switch (command.toLowerCase()) {
            case 'new': {
                const chatId = message.from;

                await sql`INSERT INTO chats(chat_id, conversation_id) VALUES (${chatId}, NULL)`;
                message.reply('New conversation started.');
                return;
            }
            case 'video': {
                const [url] = args;

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
                            setTimeout(() => fs.unlinkSync(downloadedFilepath), 1000*60*20);
                        } catch (error) {
                            console.error(error);
                            message.reply('An error occurred while processing the video.');
                        }
                    });
                });

                return;
            }
            case 'audio': {
                const [url] = args;

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
                        setTimeout(() => fs.unlinkSync(downloadedFilepath), 1000*60*20);
                    } catch (error) {
                        console.error(error);
                        message.reply('An error occurred while processing the audio.');
                    }

                });

                return;
            };
            default: {
                message.reply(`Unknown command: ${command}`);
                return;
            }
        }
    }

    const contact = await message.getContact();
    const senderName = contact.pushname || contact.name || contact.id.user;

    const selfId = client.info.wid.user;
    const selfName = client.info.pushname || client.info.name || selfId;

    const chat = await message.getChat();
    const chatId = message.from;

    let prompt, systemPrompt;
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
        prompt = `${senderName}: ${modifiedMessage}`;
        systemPrompt = SYSTEM_PROMPT + `You are a brilliant AI assistant called ${selfName}.\nYou are in a group chat called "${chat.name}"`;
    } else {
        prompt = await replaceMentionsWithNames(message);
        systemPrompt = SYSTEM_PROMPT + `You are a brilliant AI assistant called ${selfName}`;
    }

    // Fetch existing conversation_id if available
    let [conversation] = await sql`SELECT conversation_id FROM chats WHERE chat_id = ${chatId} ORDER BY timestamp DESC LIMIT 1`;
    
    // Determine the arguments for llm
    const args = conversation?.conversation_id
        ? ['--conversation', conversation.conversation_id, prompt]
        : ["--system", systemPrompt, prompt];

    const llmProcess = spawn('llm', args);
    let stdoutData = '';

    llmProcess.stdout.on('data', (data) => {
        stdoutData += data;
        chat.sendStateTyping();
    });

    llmProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });

    llmProcess.on('close', async (code) => {
        if (code !== 0) {
            console.error(`llm process exited with code ${code}`);
            return;
        }

        const reply = stdoutData.trim();
        message.reply(reply);
        console.log(reply);

        // If no existing conversation, fetch the latest conversation_id and store it
        if (!conversation?.conversation_id) {
            const newConversationId = await fetchLatestConversationId();
            await sql`DELETE FROM chats WHERE chat_id = ${chatId} AND conversation_id IS NULL;`;
            await sql`INSERT INTO chats(chat_id, conversation_id) VALUES (${chatId}, ${newConversationId});`;
        }
    });
});

client.initialize();

const util = require('util');
const execAsync = util.promisify(exec);
async function fetchLatestConversationId () {
    const { stdout } = await execAsync('llm logs');
    const logs = JSON.parse(stdout);
    const conversation_id = logs[0].conversation_id;
    return conversation_id;
};

async function shouldRespond (message, selfId) {
    if (message.mentionedIds.some(contactId => contactId.startsWith(selfId))) {
        return true;
    }

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

