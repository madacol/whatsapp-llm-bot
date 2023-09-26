const sqlite3 = require('sqlite3').verbose();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { exec, spawn } = require('child_process');

const db = new sqlite3.Database('./chats.db');

// Initialize the database table
db.run(/*sql*/`
    CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        conversation_id TEXT
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

    const contact = await message.getContact();
    const name = contact.pushname || contact.name || contact.id.user;
    const sender = contact.id.user;

    const chat = await message.getChat();
    const selfId = client.info.wid.user;
    const chatId = message.from;

    let prompt;
    if (chat.isGroup) {
        // Call shouldRespond to determine if the bot should process this message
        if (!await shouldRespond(message, selfId)) {
            return;
        }

        const modifiedMessage = await replaceMentionsWithNames(message);

        // prepend name of sender to message
        prompt = `${name}: ${modifiedMessage}`;
    } else {
        prompt = await replaceMentionsWithNames(message);;
    }
    
    // Fetch existing conversation_id if available
    let [conversation] = await sql`SELECT conversation_id FROM chats WHERE chat_id = ${chatId}`;
    
    // Determine the arguments for llm
    const args = conversation
        ? ['--conversation', conversation.conversation_id, prompt]
        : [prompt];
    
    console.log(message, chat, contact)
    console.log(chatId, sender , args);

    const llmProcess = spawn('llm', args);
    let stdoutData = '';

    llmProcess.stdout.on('data', (data) => {
        stdoutData += data;
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
        if (!conversation) {
            const newConversationId = await fetchLatestConversationId();
            await sql`INSERT INTO chats(chat_id, conversation_id) VALUES (${chatId}, ${newConversationId})`;
        }
    });
});

client.initialize();

const util = require('util');
const execAsync = util.promisify(exec);
async function fetchLatestConversationId () {
    const { stdout } = await execAsync('llm logs');
    const logs = JSON.parse(stdout);
    return logs.at(-1)?.conversation_id;
};

async function shouldRespond (message, selfId) {
    if (message.mentionedIds.some(contactId => contactId.startsWith(selfId))) {
        // Remove mention of self from start of message
        const mentionPattern = new RegExp(`^@${selfId} *`, 'g');
        message.body = message.body.replace(mentionPattern, '');
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