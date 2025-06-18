import fs from 'fs/promises';
import path from 'path';
import { getDb } from './db.js';
import config from './config.js';
import { shortenToolId } from './utils.js';

const currentSessionDb = getDb("memory://");

// Note: Action-specific messaging functions are now created inline in executeAction()

/**
 * Execute a custom action
 * @param {string} actionName - The name of the action to execute
 * @param {Context} context - The unified context to pass to the action
 * @param {{}} params - The parameters to pass to the action
 * @param {string|null} toolCallId - The tool call ID for messaging headers
 * @returns {Promise<{result: ActionResult, permissions: Action['permissions']}>} Result of the action execution
 */
export async function executeAction(actionName, context, params, toolCallId = null) {
  const action = await getAction(actionName);
  if (!action) {
    throw new Error(`Action "${actionName}" not found`);
  }

  if (action.permissions?.requireAdmin && !context.isAdmin) {
    throw new Error(`Action "${actionName}" requires admin permissions`);
  }

  if (action.permissions?.requireRoot && (context.senderId !== config.MASTER_ID) ) {
    throw new Error(`Action "${actionName}" requires master permissions`);
  }

  // Create action-specific messaging functions with headers baked in
  const shortId = shortenToolId(toolCallId || "command");
  
  const actionContext = {
    chatId: context.chatId,
    senderId: context.senderId,
    content: context.content,
    isAdmin: context.isAdmin,
    sessionDb: currentSessionDb,
    getActions,
    log: async (...args) => {
      const message = args.join(' ');
      console.log(...args);
      await context.sendMessage(`📝 *Log*    [${shortId}]`, message);
      return message;
    },
    sendMessage: async (message) => {
      await context.sendMessage(`🔧 *Action*    [${shortId}]`, message);
    },
    reply: async (message) => {
      await context.reply(`🔧 *Action*    [${shortId}]`, message);
    }
  }
  
  if (action.permissions?.useChatDb) { actionContext.chatDb = getDb(`./pgdata/${actionName}`); }
  if (action.permissions?.useRootDb) { actionContext.rootDb = getDb('./pgdata/root'); }
  // if (action.permissions?.useFileSystem) { actionContext.directoryHandle = directoryHandle; }

  // If the action doesn't require confirmation, execute it immediately
  if (action.permissions?.autoExecute) {
    try {
      return {
        result: await action.action_fn(actionContext, params),
        permissions: action.permissions
      };
    } catch (error) {
      console.error(`Error executing action ${actionName}:`, error);
      throw error;
    }
  }

  throw new Error(`Action "${actionName}" requires confirmation, which is not yet implemented in this environment.`);
}

// Note: log function is now created per-action in createActionLog()

let directoryHandle;

/**
 * Initializes and returns the absolute path to the 'actions' directory.
 * Ensures the directory exists.
 * @returns {Promise<string>} Absolute path to the actions directory
 */
export async function initializeDirectoryHandle() {
  const actionsDir = path.resolve(process.cwd(), 'actions');
  try {
    await fs.mkdir(actionsDir, { recursive: true });
  } catch (err) {
    // Directory may already exist, ignore error
  }
  return actionsDir;
}

/**
 * Retrieves all available actions from the actions directory
 * @returns {Promise<AppAction[]>} Array of action objects with name derived from filename
 */
export async function getActions() {
  if (!directoryHandle) {
    directoryHandle = await initializeDirectoryHandle();
  }

  const actionsDir = directoryHandle;
  const files = await fs.readdir(actionsDir);
  /** @type {AppAction[]} */
  actions = (await Promise.all(
    files
      .filter(file => file.endsWith('.js'))
      .map(async (file) => {
        const filePath = path.join(actionsDir, file);
        try {
          const module = await import(`file://${filePath}`);
          if (module.default) {
            return {
              ...module.default,
              fileName: file,
              app_name: ''
            };
          }
          console.error(`Action ${file} has no default export`);
          return null;
        } catch (importError) {
          console.error(`Error importing action ${file}:`, importError);
          return null;
        }
      })
  )).filter(action => action !== null);

  return actions;
}

/** @type {AppAction[]} */
let actions;

/**
 * Get a specific action by name from the file system
 * @param {string} actionName - The name of the action to retrieve
 * @returns {Promise<AppAction|null>} The action object or null if not found
 */
export async function getAction(actionName) {
  if (!directoryHandle) {
    directoryHandle = await initializeDirectoryHandle();
  }

  // Find the file with the matching action name
  const fileName = actions.find(action => action.name === actionName)?.fileName;
  if (!fileName) {
    throw new Error(`Action "${actionName}" not found`);
  }

  const filePath = path.join(directoryHandle, fileName);

  try {
    // Import the module directly from the file path
    const module = await import(`file://${filePath}`);
    const action = module.default;

    if (action) {
      return {
        ...action,
        app_name: '',
        fileName
      };
    }

    console.error(`Action ${fileName} has no default export`);
    return null;
  } catch (error) {
    console.error(`Error importing action file for ${actionName}:`, error);
    return null;
  }
}
