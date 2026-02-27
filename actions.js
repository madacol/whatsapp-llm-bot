import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { getDb, getRootDb, getChatDb, getActionDb } from "./db.js";
import config from "./config.js";
import { createCallLlm } from "./llm.js";
import { savePendingConfirmation, deletePendingConfirmation } from "./pending-confirmations.js";


const currentSessionDb = getDb("memory://");

// Note: Action-specific messaging functions are now created inline in executeAction()

/**
 * Execute a custom action
 * @param {string} actionName - The name of the action to execute
 * @param {Context} context - The unified context to pass to the action
 * @param {{}} params - The parameters to pass to the action
 * @param {string|null} [_toolCallId=null] - The tool call ID (unused, kept for API compatibility)
 * @param {(name: string) => Promise<AppAction|null>} [actionResolver] - Optional resolver (defaults to getAction)
 * @param {import("openai").default} [llmClient] - Optional LLM client for actions with useLlm permission
 * @returns {Promise<{result: ActionResult, permissions: Action['permissions']}>} Result of the action execution
 */
export async function executeAction(
  actionName,
  context,
  params,
  _toolCallId = null,
  actionResolver = getAction,
  llmClient,
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

  // Wrap confirm with persistence hooks so confirmations survive restarts
  const rootDb = getRootDb();
  /** @type {(message: string, hooks?: import("./whatsapp-adapter.js").ConfirmHooks) => Promise<boolean>} */
  const originalConfirm = context.confirm;
  /** @type {(message: string) => Promise<boolean>} */
  const persistentConfirm = (message) => originalConfirm(message, {
    onSent: async (msgKey) => {
      await savePendingConfirmation(rootDb, {
        chatId: context.chatId,
        msgKeyId: msgKey.id,
        msgKeyRemoteJid: msgKey.remoteJid,
        actionName,
        actionParams: params,
        toolCallId: _toolCallId,
        senderIds: context.senderIds,
      });
    },
    onResolved: async (msgKey) => {
      await deletePendingConfirmation(rootDb, msgKey.id);
    },
  });

  /** @type {ActionContext & Partial<{chatDb: PGlite, rootDb: PGlite, callLlm: CallLlm, llmClient: import("openai").default}>} */
  const actionContext = {
    chatId: context.chatId,
    senderIds: context.senderIds,
    content: context.content,
    getIsAdmin: context.getIsAdmin,
    db: getActionDb(context.chatId, actionName),
    sessionDb: currentSessionDb,
    getActions,
    log: async (...args) => {
      const message = args.join(" ");
      console.log(...args);
      return message;
    },
    sendMessage: async (message) => {
      await context.sendMessage(`🔧 ${message}`);
    },
    reply: async (message) => {
      await context.reply(`🔧 ${message}`);
    },
    reactToMessage: context.reactToMessage,
    sendPoll: context.sendPoll,
    sendImage: context.sendImage,
    confirm: persistentConfirm,
  };

  if (action.permissions?.useChatDb) {
    actionContext.chatDb = getChatDb(context.chatId);
  }
  if (action.permissions?.useRootDb) {
    actionContext.rootDb = getRootDb();
  }
  if (action.permissions?.useLlm) {
    if (!llmClient) {
      throw new Error(`Action "${actionName}" requires useLlm but no llmClient was provided`);
    }
    actionContext.callLlm = createCallLlm(llmClient);
    actionContext.llmClient = llmClient;
  }

  if (!action.permissions?.autoExecute) {
    const confirmed = await persistentConfirm(
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
  const files = await fs.readdir(dir, { recursive: true });
  /** @type {AppAction[]} */
  actions = (
    await Promise.all(
      files
        .filter((file) => file.endsWith(".js") && !path.basename(file).startsWith("_"))
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

// ── Chat-scoped actions ──

/** @type {Set<keyof PermissionFlags>} */
export const ALLOWED_CHAT_PERMISSIONS = new Set([
  "autoExecute",
  "autoContinue",
  "useLlm",
  "requireAdmin",
]);

/**
 * Ensures the chat_actions table exists in the given DB.
 * @param {PGlite} db
 */
export async function ensureChatActionsSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_actions (
      name TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

/**
 * Upsert a chat action into the DB.
 * @param {PGlite} db
 * @param {string} name
 * @param {string} code
 */
export async function saveChatAction(db, name, code) {
  await ensureChatActionsSchema(db);
  await db.query(
    `INSERT INTO chat_actions (name, code) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET code = $2, created_at = NOW()`,
    [name, code],
  );
}

/**
 * Read a chat action's code from the DB.
 * @param {PGlite} db
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function readChatAction(db, name) {
  await ensureChatActionsSchema(db);
  const { rows } = await db.query(
    `SELECT code FROM chat_actions WHERE name = $1`,
    [name],
  );
  return rows.length > 0 ? /** @type {string} */ (rows[0].code) : null;
}

/**
 * Delete a chat action from the DB.
 * @param {PGlite} db
 * @param {string} name
 */
export async function deleteChatAction(db, name) {
  await ensureChatActionsSchema(db);
  await db.query(`DELETE FROM chat_actions WHERE name = $1`, [name]);
}

const CHAT_ACTION_CACHE_MAX = 100;

/** @type {Map<string, AppAction>} */
const chatActionCache = new Map();

/**
 * Import a chat action from code string by writing to a temp file.
 * Caches by (chatId, name, code hash) to avoid re-importing unchanged actions.
 * @param {string} chatId
 * @param {string} name
 * @param {string} code
 * @returns {Promise<AppAction | null>}
 */
async function importChatAction(chatId, name, code) {
  const codeHash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);
  const cacheKey = `${chatId}:${name}:${codeHash}`;

  const cached = chatActionCache.get(cacheKey);
  if (cached) return cached;

  const tmpFile = path.join(os.tmpdir(), `chat-action-${codeHash}.mjs`);
  try {
    await fs.writeFile(tmpFile, code, "utf-8");
    const module = await import(`file://${tmpFile}?t=${Date.now()}`);
    if (!module.default) {
      console.error(`Chat action "${name}" has no default export`);
      return null;
    }

    /** @type {PermissionFlags} */
    const clampedPermissions = {};
    if (module.default.permissions) {
      for (const key of Object.keys(module.default.permissions)) {
        if (ALLOWED_CHAT_PERMISSIONS.has(/** @type {keyof PermissionFlags} */ (key))) {
          clampedPermissions[/** @type {keyof PermissionFlags} */ (key)] = module.default.permissions[key];
        }
      }
    }

    /** @type {AppAction} */
    const action = {
      ...module.default,
      permissions: clampedPermissions,
      scope: "chat",
      fileName: `chat:${chatId}:${name}`,
      app_name: "",
    };

    // Evict oldest entries when cache exceeds max size
    if (chatActionCache.size >= CHAT_ACTION_CACHE_MAX) {
      const firstKey = chatActionCache.keys().next().value;
      if (firstKey !== undefined) chatActionCache.delete(firstKey);
    }
    chatActionCache.set(cacheKey, action);
    return action;
  } catch (error) {
    console.error(`Error importing chat action "${name}":`, error);
    return null;
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

/**
 * Load all chat-scoped actions for a given chat.
 * @param {string} chatId
 * @returns {Promise<AppAction[]>}
 */
export async function getChatActions(chatId) {
  const db = getActionDb(chatId, "create_action");
  try {
    await ensureChatActionsSchema(db);
    const { rows } = await db.query(`SELECT name, code FROM chat_actions`);
    /** @type {AppAction[]} */
    const results = [];
    for (const row of rows) {
      const action = await importChatAction(chatId, /** @type {string} */ (row.name), /** @type {string} */ (row.code));
      if (action) results.push(action);
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Load a single chat action by name.
 * @param {string} chatId
 * @param {string} actionName
 * @returns {Promise<AppAction | null>}
 */
export async function getChatAction(chatId, actionName) {
  const db = getActionDb(chatId, "create_action");
  const code = await readChatAction(db, actionName);
  if (!code) return null;
  return importChatAction(chatId, actionName, code);
}
