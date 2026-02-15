import fs from "fs/promises";
import path from "path";

export default /** @type {defineAction} */ ((x) => x)({
  name: "create_action",
  description: `Create a new action file in the actions/ directory. The code must be a complete ES module that default-exports an action object using the standard boilerplate:

\`\`\`js
export default /** @type {defineAction} */ ((x) => x)({
  name: "action_name",        // snake_case
  command: "cmd",              // optional shortcut (!cmd)
  description: "What it does",
  parameters: {
    type: "object",
    properties: {
      paramName: { type: "string", description: "..." }
    },
    required: ["paramName"]
  },
  permissions: {
    autoExecute: true,    // execute without confirmation
    autoContinue: true,   // continue LLM processing after
    requireAdmin: true,   // requires group admin
    requireMaster: true,  // requires MASTER_ID
    useChatDb: true,      // adds chatDb (PGlite) to context
    useRootDb: true,      // adds rootDb (PGlite) to context
    useLlm: true,         // adds callLlm(prompt, options?) to context
  },
  action_fn: async function (context, params) {
    // context has: chatId, senderIds, content, getIsAdmin, sessionDb, getActions, log, sendMessage, reply
    // plus permission-granted extras above
    return "result string";
  }
});
\`\`\`

Only set the permissions you actually need.`,
  parameters: {
    type: "object",
    properties: {
      file_name: {
        type: "string",
        description:
          "camelCase file name without extension (e.g. 'myAction' creates actions/myAction.js)",
      },
      code: {
        type: "string",
        description: "Complete file content (ES module with default export)",
      },
    },
    required: ["file_name", "code"],
  },
  permissions: {
    autoExecute: true,
    requireMaster: true,
  },
  action_fn: async function (_context, { file_name, code }) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(file_name)) {
      throw new Error(
        "file_name must be alphanumeric camelCase (no dots, slashes, or spaces)",
      );
    }

    const actionsDir = path.resolve(process.cwd(), "actions");
    const filePath = path.join(actionsDir, `${file_name}.js`);

    await fs.writeFile(filePath, code, "utf-8");

    return `Action file created: actions/${file_name}.js`;
  },
});
