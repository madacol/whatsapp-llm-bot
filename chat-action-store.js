import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getActionDb } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("chat-action-store");

/** @type {Set<keyof PermissionFlags>} */
export const ALLOWED_CHAT_PERMISSIONS = new Set([
  "autoExecute",
  "autoContinue",
  "useLlm",
  "requireAdmin",
]);

/**
 * Ensure the chat_actions table exists.
 * @param {PGlite} db
 * @returns {Promise<void>}
 */
export async function ensureChatActionsSchema(db) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS chat_actions (
      name TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
}

/**
 * Upsert a chat action into the DB.
 * @param {PGlite} db
 * @param {string} name
 * @param {string} code
 * @returns {Promise<void>}
 */
export async function saveChatAction(db, name, code) {
  await ensureChatActionsSchema(db);
  await db.sql`INSERT INTO chat_actions (name, code) VALUES (${name}, ${code})
     ON CONFLICT (name) DO UPDATE SET code = ${code}, created_at = NOW()`;
}

/**
 * Read a chat action's code from the DB.
 * @param {PGlite} db
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function readChatAction(db, name) {
  await ensureChatActionsSchema(db);
  const { rows } = await db.sql`SELECT code FROM chat_actions WHERE name = ${name}`;
  return rows.length > 0 ? /** @type {string} */ (rows[0].code) : null;
}

/**
 * Delete a chat action from the DB.
 * @param {PGlite} db
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function deleteChatAction(db, name) {
  await ensureChatActionsSchema(db);
  await db.sql`DELETE FROM chat_actions WHERE name = ${name}`;
}

const CHAT_ACTION_CACHE_MAX = 100;

/** @type {Map<string, AppAction>} */
const chatActionCache = new Map();

/**
 * Clamp chat action permissions to the allowed subset.
 * @param {PermissionFlags | undefined} permissions
 * @returns {PermissionFlags}
 */
function clampChatPermissions(permissions) {
  /** @type {PermissionFlags} */
  const clampedPermissions = {};
  if (!permissions) {
    return clampedPermissions;
  }

  for (const key of Object.keys(permissions)) {
    const permissionKey = /** @type {keyof PermissionFlags} */ (key);
    if (ALLOWED_CHAT_PERMISSIONS.has(permissionKey)) {
      clampedPermissions[permissionKey] = permissions[permissionKey];
    }
  }

  return clampedPermissions;
}

/**
 * Import one chat action from source code, caching by chat/name/code hash.
 * @param {string} chatId
 * @param {string} name
 * @param {string} code
 * @returns {Promise<AppAction | null>}
 */
async function importChatAction(chatId, name, code) {
  const codeHash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);
  const cacheKey = `${chatId}:${name}:${codeHash}`;
  const cached = chatActionCache.get(cacheKey);
  if (cached) {
    chatActionCache.delete(cacheKey);
    chatActionCache.set(cacheKey, cached);
    return cached;
  }

  const tmpFile = path.join(os.tmpdir(), `chat-action-${codeHash}.mjs`);
  try {
    await fs.writeFile(tmpFile, code, "utf-8");
    const module = await import(`file://${tmpFile}?t=${Date.now()}`);
    if (!module.default) {
      log.error(`Chat action "${name}" has no default export`);
      return null;
    }

    /** @type {AppAction} */
    const action = {
      ...module.default,
      permissions: clampChatPermissions(module.default.permissions),
      scope: "chat",
      fileName: `chat:${chatId}:${name}`,
      app_name: "",
    };

    if (chatActionCache.size >= CHAT_ACTION_CACHE_MAX) {
      const firstKey = chatActionCache.keys().next().value;
      if (firstKey !== undefined) {
        chatActionCache.delete(firstKey);
      }
    }

    chatActionCache.set(cacheKey, action);
    return action;
  } catch (error) {
    log.error(`Error importing chat action "${name}":`, error);
    return null;
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

/**
 * Load all chat-scoped actions for a chat.
 * @param {string} chatId
 * @returns {Promise<AppAction[]>}
 */
export async function getChatActions(chatId) {
  const db = getActionDb(chatId, "create_action");
  try {
    await ensureChatActionsSchema(db);
    const { rows } = await db.sql`SELECT name, code FROM chat_actions`;
    /** @type {AppAction[]} */
    const results = [];
    for (const row of rows) {
      const action = await importChatAction(
        chatId,
        /** @type {string} */ (row.name),
        /** @type {string} */ (row.code),
      );
      if (action) {
        results.push(action);
      }
    }
    return results;
  } catch (error) {
    log.error(`Error loading chat actions for ${chatId}:`, error);
    return [];
  }
}

/**
 * Load one chat-scoped action by name.
 * @param {string} chatId
 * @param {string} actionName
 * @returns {Promise<AppAction | null>}
 */
export async function getChatAction(chatId, actionName) {
  const db = getActionDb(chatId, "create_action");
  const code = await readChatAction(db, actionName);
  if (!code) {
    return null;
  }
  return importChatAction(chatId, actionName, code);
}
