const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    model: process.env.MODEL,
    llm_api_key: process.env.LLM_API_KEY,
    base_url: process.env.BASE_URL,
    system_prompt: process.env.SYSTEM_PROMPT ||
`You are an assistant that provides accurate, direct and honest answers.
Avoid unnecessary commentary, jokes or informal asides—focus on clarity and correctness.
You are in a WhatsApp chat, so you may use emojis and WhatsApp formatting to enhance readability.`
}