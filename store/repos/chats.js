import {
  normalizeChatRow,
  normalizeHarnessForkStack,
  normalizeHarnessForkStackEntry,
  normalizeHarnessSessionHistory,
} from "../normalizers.js";
import {
  ensureChatConfig,
  mirrorChatConfigToDb,
  readChatConfig,
  updateChatConfig,
} from "../../chat-config.js";

/** @typedef {import("../../store.js").Store} Store */
/** @typedef {import("../../store.js").ChatRow} ChatRow */
/** @typedef {import("../../store.js").HarnessSessionHistoryEntry} HarnessSessionHistoryEntry */
/** @typedef {import("../../store.js").HarnessForkStackEntry} HarnessForkStackEntry */

/**
 * @typedef {{
 *   getChatDb: (chatId: string) => Promise<PGlite>;
 *   ensureChatExists: (chatId: string) => Promise<void>;
 * }} ChatStoreDeps
 */

/**
 * Build chat and harness-session store methods.
 * @param {ChatStoreDeps} deps
 * @returns {Pick<Store,
 *   "getChat"
 *   | "createChat"
 *   | "setChatEnabled"
 *   | "copyChatCustomizations"
 *   | "saveHarnessSession"
 *   | "archiveHarnessSession"
 *   | "getHarnessSessionHistory"
 *   | "restoreHarnessSession"
 *   | "getHarnessForkStack"
 *   | "pushHarnessForkStack"
 *   | "popHarnessForkStack"
 * >}
 */
export function createChatStore({ getChatDb, ensureChatExists }) {
  /**
   * @param {ChatRow["chat_id"]} chatId
   * @returns {Promise<ChatRow | undefined>}
   */
  async function getChat(chatId) {
    const configChat = await readChatConfig(chatId);
    if (configChat) {
      return configChat;
    }
    const db = await getChatDb(chatId);
    const { rows: [row] } = await db.sql`SELECT * FROM chats WHERE chat_id = ${chatId}`;
    const chat = normalizeChatRow(row);
    if (!chat) {
      return undefined;
    }
    await ensureChatConfig(chatId, chat);
    return chat;
  }

  return {
    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<ChatRow | undefined>}
     */
    getChat,

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<void>}
     */
    async createChat(chatId) {
      await ensureChatExists(chatId);
    },

    /**
     * @param {string} chatId
     * @param {boolean} enabled
     * @returns {Promise<void>}
     */
    async setChatEnabled(chatId, enabled) {
      await ensureChatExists(chatId);
      const db = await getChatDb(chatId);
      const chat = await updateChatConfig(chatId, (current) => ({ ...current, is_enabled: enabled }));
      await mirrorChatConfigToDb(db, chat);
    },

    /**
     * Copy user-configurable chat settings into a new chat without carrying
     * over path bindings or live session state.
     * @param {string} sourceChatId
     * @param {string} targetChatId
     * @returns {Promise<void>}
     */
    async copyChatCustomizations(sourceChatId, targetChatId) {
      await ensureChatExists(sourceChatId);
      await ensureChatExists(targetChatId);

      const sourceChat = await getChat(sourceChatId);
      if (!sourceChat) {
        throw new Error(`Chat ${sourceChatId} does not exist.`);
      }

      const db = await getChatDb(targetChatId);
      const chat = await updateChatConfig(targetChatId, (current) => ({
        ...current,
        system_prompt: sourceChat.system_prompt,
        model: sourceChat.model,
        respond_on_any: sourceChat.respond_on_any,
        respond_on_mention: sourceChat.respond_on_mention,
        respond_on_reply: sourceChat.respond_on_reply,
        respond_on: sourceChat.respond_on,
        debug: sourceChat.debug,
        media_to_text_models: sourceChat.media_to_text_models ?? {},
        model_roles: sourceChat.model_roles ?? {},
        memory: sourceChat.memory,
        memory_threshold: sourceChat.memory_threshold,
        enabled_actions: sourceChat.enabled_actions ?? [],
        active_persona: sourceChat.active_persona,
        harness: sourceChat.harness,
        output_visibility: sourceChat.output_visibility ?? {},
        harness_config: sourceChat.harness_config ?? {},
      }));
      await mirrorChatConfigToDb(db, chat);
    },

    /**
     * Save the current harness session for a chat, or clear it when null.
     * @param {ChatRow["chat_id"]} chatId
     * @param {HarnessSessionRef | null} session
     * @returns {Promise<void>}
     */
    async saveHarnessSession(chatId, session) {
      const db = await getChatDb(chatId);
      const chat = await updateChatConfig(chatId, (current) => ({
        ...current,
        harness_session_id: session?.id ?? null,
        harness_session_kind: session?.kind ?? null,
      }));
      await mirrorChatConfigToDb(db, chat);
    },

    /**
     * Archive the current harness session into the session history.
     * Does nothing if there is no current session.
     * Keeps at most `maxEntries` entries (oldest are dropped).
     * @param {ChatRow["chat_id"]} chatId
     * @param {{ maxEntries?: number, title?: string | null }} [options]
     * @returns {Promise<HarnessSessionHistoryEntry | null>}
     */
    async archiveHarnessSession(chatId, options = {}) {
      const maxEntries = options.maxEntries ?? 10;
      const chat = await getChat(chatId);
      if (!chat?.harness_session_id || !chat.harness_session_kind) {
        return null;
      }

      const history = normalizeHarnessSessionHistory(chat.harness_session_history);
      if (history.some((entry) => entry.id === chat.harness_session_id && entry.kind === chat.harness_session_kind)) {
        return null;
      }

      /** @type {HarnessSessionHistoryEntry} */
      const entry = {
        id: chat.harness_session_id,
        kind: chat.harness_session_kind,
        cleared_at: new Date().toISOString(),
        title: typeof options.title === "string" && options.title.trim() ? options.title.trim() : null,
      };
      const updated = [...history, entry].slice(-maxEntries);

      const db = await getChatDb(chatId);
      const updatedChat = await updateChatConfig(chatId, (current) => ({
        ...current,
        harness_session_history: updated,
        harness_session_id: null,
        harness_session_kind: null,
      }));
      await mirrorChatConfigToDb(db, updatedChat);
      return entry;
    },

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<HarnessSessionHistoryEntry[]>}
     */
    async getHarnessSessionHistory(chatId) {
      const chat = await getChat(chatId);
      if (!chat) {
        return [];
      }
      return normalizeHarnessSessionHistory(chat.harness_session_history);
    },

    /**
     * Restore a session from history by index (0 = most recent) or session ID.
     * Removes it from history and sets it as the active session.
     * Caller should call `archiveHarnessSession` first to save any active session.
     * @param {ChatRow["chat_id"]} chatId
     * @param {number | string} indexOrId
     * @returns {Promise<HarnessSessionHistoryEntry | null>}
     */
    async restoreHarnessSession(chatId, indexOrId) {
      const chat = await getChat(chatId);
      if (!chat) {
        return null;
      }

      const history = normalizeHarnessSessionHistory(chat.harness_session_history);
      if (history.length === 0) {
        return null;
      }

      const index = typeof indexOrId === "number"
        ? history.length - 1 - indexOrId
        : history.findIndex((entry) => entry.id === indexOrId);
      if (index < 0 || index >= history.length) {
        return null;
      }

      const entry = history[index];
      history.splice(index, 1);

      const db = await getChatDb(chatId);
      const updatedChat = await updateChatConfig(chatId, (current) => ({
        ...current,
        harness_session_id: entry.id,
        harness_session_kind: entry.kind,
        harness_session_history: history,
      }));
      await mirrorChatConfigToDb(db, updatedChat);
      return entry;
    },

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<HarnessForkStackEntry[]>}
     */
    async getHarnessForkStack(chatId) {
      const chat = await getChat(chatId);
      if (!chat) {
        return [];
      }
      return normalizeHarnessForkStack(chat.harness_fork_stack);
    },

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @param {HarnessForkStackEntry} entry
     * @returns {Promise<void>}
     */
    async pushHarnessForkStack(chatId, entry) {
      const chat = await getChat(chatId);
      const stack = normalizeHarnessForkStack(chat?.harness_fork_stack);
      const normalizedEntry = normalizeHarnessForkStackEntry(entry);
      if (!normalizedEntry) {
        throw new Error("Invalid harness fork stack entry");
      }

      const db = await getChatDb(chatId);
      const updatedChat = await updateChatConfig(chatId, (current) => ({
        ...current,
        harness_fork_stack: [...stack, normalizedEntry],
      }));
      await mirrorChatConfigToDb(db, updatedChat);
    },

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<HarnessForkStackEntry | null>}
     */
    async popHarnessForkStack(chatId) {
      const chat = await getChat(chatId);
      const stack = normalizeHarnessForkStack(chat?.harness_fork_stack);
      const entry = stack.pop() ?? null;

      const db = await getChatDb(chatId);
      const updatedChat = await updateChatConfig(chatId, (current) => ({
        ...current,
        harness_fork_stack: stack,
      }));
      await mirrorChatConfigToDb(db, updatedChat);
      return entry;
    },
  };
}
