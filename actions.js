/**
 * Thin facade preserving the historical actions.js export surface.
 * Internal concerns now live in focused modules:
 * - action-catalog.js
 * - chat-action-store.js
 * - action-executor.js
 */

export { getActions, getAction } from "./action-catalog.js";
export {
  ALLOWED_CHAT_PERMISSIONS,
  ensureChatActionsSchema,
  saveChatAction,
  readChatAction,
  deleteChatAction,
  getChatActions,
  getChatAction,
} from "./chat-action-store.js";
export { executeAction } from "./action-executor.js";
