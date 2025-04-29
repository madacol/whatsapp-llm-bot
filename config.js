const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    model: process.env.MODEL,
    llm_api_key: process.env.LLM_API_KEY,
    base_url: process.env.BASE_URL,
    system_prompt: process.env.SYSTEM_PROMPT ||
`You are a helpful assistant that can answer questions and help with tasks.

You are currently in a Whatsapp chat, so you can use emojis and Whatsapp's formatting to craft your messages.`
}