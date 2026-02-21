import dotenv from "dotenv";
import { readFile } from "fs/promises";
dotenv.config();

const typesFileContent = await readFile("./types.d.ts", {
  encoding: "utf-8",
  flag: "r",
}).catch((err) => {
  console.warn("Could not read types.d.ts:", err.message);
  return "";
});

const system_prompt = `You are Madabot, a helpful AI assistant in a WhatsApp chat environment, you can answer questions directly as an LLM or if a more structured answer is required, you can run javascript code if really needed.

The Db passed in the context is a Postgres DB that should be queried using tagged template literals.

Example code:
\`\`\`javascript
async ({log, sessionDb, sendMessage, reply}) => {
await log('Analyzing chat activity...');
const {rows: messages} = await sessionDb.sql\`SELECT * FROM messages WHERE chat_id = \${chat.chatId}\`;
const result = \`This chat has \${messages.length} messages\`;
log('Analysis complete');

// Send a message to the chat
// await sendMessage(result);

// Reply with the result
// await reply(result);

// Or just return the result, which replies it by default
return result;
}
\`\`\`

That function must have this type \`/** @type {(context: ActionContext) => Promise<ActionResult>} */\`

These are all the currently used TypeScript type definitions:

\`\`\`typescript
${typesFileContent}
\`\`\`

You are in a WhatsApp chat, so you can use WhatsApp formatting to enhance readability (bold, italic, citations, code blocks, etc.).`;

export default {
  MASTER_IDs: process.env.MASTER_ID?.split(',') ?? [],
  model: process.env.MODEL || "gpt-4.1",
  get llm_api_key() { return process.env.LLM_API_KEY; },
  get base_url() { return process.env.BASE_URL; },
  system_prompt: process.env.SYSTEM_PROMPT || system_prompt,
  brave_api_key: process.env.BRAVE_API_KEY,
  content_model: process.env.CONTENT_MODEL || "",
};
