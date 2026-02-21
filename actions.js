import fs from "fs/promises";
import path from "path";
import { getDb } from "./db.js";
import config from "./config.js";
import { createLlmClient, createCallLlm } from "./llm.js";
import { shortenToolId } from "./utils.js";

const llmClient = createLlmClient();

const currentSessionDb = getDb("memory://");

// Note: Action-specific messaging functions are now created inline in executeAction()

/**
 * Execute a custom action
 * @param {string} actionName - The name of the action to execute
 * @param {Context} context - The unified context to pass to the action
 * @param {{}} params - The parameters to pass to the action
 * @param {string|null} toolCallId - The tool call ID for messaging headers
 * @param {(name: string) => Promise<AppAction|null>} [actionResolver] - Optional resolver (defaults to getAction)
 * @returns {Promise<{result: ActionResult, permissions: Action['permissions']}>} Result of the action execution
 */
export async function executeAction(
  actionName,
  context,
  params,
  toolCallId = null,
  actionResolver = getAction,
) {
  const action = await actionResolver(actionName);
  if (!action) {
    throw new Error(`Action "${actionName}" not found`);
  }

  if (action.permissions?.requireAdmin && !(await context.getIsAdmin())) {
    throw new Error(`Action "${actionName}" requires admin permissions`);
  }

  if (
    action.permissions?.requireMaster &&
    !context.senderIds.some(senderId => config.MASTER_IDs.includes(senderId))
  ) {
    throw new Error(`Action "${actionName}" requires master permissions`);
  }

  // Create action-specific messaging functions with headers baked in
  const shortId = shortenToolId(toolCallId || "command");

  /** @type {ActionContext & Partial<{chatDb: PGlite, rootDb: PGlite, callLlm: CallLlm}>} */
  const actionContext = {
    chatId: context.chatId,
    senderIds: context.senderIds,
    content: context.content,
    getIsAdmin: context.getIsAdmin,
    db: getDb(`./pgdata/${context.chatId}/${actionName}`),
    sessionDb: currentSessionDb,
    getActions,
    log: async (...args) => {
      const message = args.join(" ");
      console.log(...args);
      if (context.isDebug) {
        await context.sendMessage(`📝 ${message}`);
      }
      return message;
    },
    sendMessage: async (message) => {
      if (context.isDebug) {
        await context.sendMessage(`🔧 *Action*    [${shortId}]`, message);
      } else {
        await context.sendMessage(`🔧 ${message}`);
      }
    },
    reply: async (message) => {
      if (context.isDebug) {
        await context.reply(`🔧 *Action*    [${shortId}]`, message);
      } else {
        await context.reply(`🔧 ${message}`);
      }
    },
    reactToMessage: context.reactToMessage,
    sendPoll: context.sendPoll,
    confirm: context.confirm,
  };

  if (action.permissions?.useChatDb) {
    actionContext.chatDb = getDb(`./pgdata/${context.chatId}`);
  }
  if (action.permissions?.useRootDb) {
    actionContext.rootDb = getDb("./pgdata/root");
  }
  // if (action.permissions?.useFileSystem) { actionContext.directoryHandle = directoryHandle; }
  if (action.permissions?.useLlm) {
    actionContext.callLlm = createCallLlm(llmClient);
  }

  if (!action.permissions?.autoExecute) {
    const confirmed = await context.confirm(
      `⚠️ *Confirm action: ${actionName}*\n\n` +
      `${action.description}\n\n` +
      `React 👍 to confirm or 👎 to cancel.`
    );
    if (!confirmed) {
      return {
        result: `Action "${actionName}" was cancelled by user.`,
        permissions: action.permissions,
      };
    }
  }

  try {
    const raw = await action.action_fn(actionContext, params);

    // Allow actions to override autoContinue per-invocation via ActionSignal
    if (raw && typeof raw === "object" && "result" in raw && "autoContinue" in raw) {
      const signal = /** @type {ActionSignal} */ (raw);
      return {
        result: signal.result,
        permissions: { ...action.permissions, autoContinue: signal.autoContinue },
      };
    }

    return {
      result: raw,
      permissions: action.permissions,
    };
  } catch (error) {
    console.error(`Error executing action ${actionName}:`, error);
    throw error;
  }
}

/** @type {string | undefined} */
let actionsDir;

/** @type {AppAction[]} */
let actions;

/**
 * Initializes and returns the absolute path to the 'actions' directory.
 * Ensures the directory exists.
 * @returns {Promise<string>} Absolute path to the actions directory
 */
export async function initializeDirectoryHandle() {
  const dir = path.resolve(process.cwd(), "actions");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Retrieves all available actions from the actions directory
 * @returns {Promise<AppAction[]>} Array of action objects with name derived from filename
 */
export async function getActions() {
  if (!actionsDir) {
    actionsDir = await initializeDirectoryHandle();
  }

  const dir = actionsDir;
  const files = await fs.readdir(dir);
  /** @type {AppAction[]} */
  actions = (
    await Promise.all(
      files
        .filter((file) => file.endsWith(".js") && !file.startsWith("_"))
        .map(async (file) => {
          const filePath = path.join(dir, file);
          try {
            const module = await import(`file://${filePath}`);
            if (module.default) {
              return {
                ...module.default,
                fileName: file,
                app_name: "",
              };
            }
            console.error(`Action ${file} has no default export`);
            return null;
          } catch (importError) {
            console.error(`Error importing action ${file}:`, importError);
            return null;
          }
        }),
    )
  ).filter((action) => action !== null);

  return actions;
}

/**
 * Get a specific action by name from the file system.
 * Re-imports the module each time to support hot-reload during development.
 * @param {string} actionName - The name of the action to retrieve
 * @returns {Promise<AppAction|null>} The action object or null if not found
 */
export async function getAction(actionName) {
  if (!actionsDir) {
    actionsDir = await initializeDirectoryHandle();
  }

  const fileName = actions.find(
    (action) => action.name === actionName,
  )?.fileName;
  if (!fileName) {
    throw new Error(`Action "${actionName}" not found`);
  }

  const filePath = path.join(actionsDir, fileName);

  try {
    const module = await import(`file://${filePath}`);
    const action = module.default;

    if (action) {
      return {
        ...action,
        app_name: "",
        fileName,
      };
    }

    console.error(`Action ${fileName} has no default export`);
    return null;
  } catch (error) {
    console.error(`Error importing action file for ${actionName}:`, error);
    return null;
  }
}
