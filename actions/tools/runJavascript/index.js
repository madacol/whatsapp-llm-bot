import { readFile } from "node:fs/promises";

const typesFileContent = await readFile(
  new URL("../../types.d.ts", import.meta.url),
  "utf-8",
).catch((err) => {
  console.warn("Could not read types.d.ts:", err.message);
  return "";
});

export default /** @type {defineAction} */ ((x) => x)({
  name: "run_javascript",
  command: "js",
  description:
    "Execute JavaScript code in a secure environment. The code must be an arrow function that receives a context object.",
  instructions: `The Db passed in the context is a Postgres DB that should be queried using tagged template literals.

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
\`\`\``,
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript code to execute (must be an arrow function that accepts a context parameter). Example: '({log, db}) => { log(\"Processing\"); return (await db.sql`SELECT * FROM table`).rows; }'",
      },
    },
    required: ["code"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /** @param {{code?: string}} params */
  formatToolCall: ({ code }) => {
    const maxLen = 80;
    if (!code) return "";
    return code.length > maxLen ? code.slice(0, maxLen) + "…" : code;
  },
  action_fn: async function (context, { code }) {
    // Handle both command args and LLM function call formats
    console.log("Executing JavaScript code:", JSON.stringify(code, null, 2));

    let fn;
    try {
      // Evaluate code
      fn = Function(`return ${code}`)();
    } catch (error) {
      console.error("Invalid JavaScript code: Is it a function?", {
        code,
        error,
      });
      throw error;
    }
    if (typeof fn !== "function") {
      console.error("fn is not a function:", { code, fn });
      throw new Error("Code must evaluate to a function");
    }
    try {
      return await fn(context);
    } catch (error) {
      console.error("Error executing function:", { code, fn, error });
      throw error;
    }
  },
});
