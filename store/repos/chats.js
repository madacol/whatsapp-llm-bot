import {
  normalizeChatRow,
  normalizeHarnessForkStack,
  normalizeHarnessForkStackEntry,
  normalizeHarnessSessionHistory,
} from "../normalizers.js";

/** @typedef {import("../../store.js").Store} Store */
/** @typedef {import("../../store.js").ChatRow} ChatRow */
/** @typedef {import("../../store.js").HarnessSessionHistoryEntry} HarnessSessionHistoryEntry */
/** @typedef {import("../../store.js").HarnessForkStackEntry} HarnessForkStackEntry */

/**
 * @typedef {{
 *   db: PGlite;
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
export function createChatStore({ db, ensureChatExists }) {
  return {
    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<ChatRow | undefined>}
     */
    async getChat(chatId) {
      const { rows: [row] } = await db.sql`SELECT * FROM chats WHERE chat_id = ${chatId}`;
      return normalizeChatRow(row) ?? undefined;
    },

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
      await db.sql`
        UPDATE chats
        SET is_enabled = ${enabled}
        WHERE chat_id = ${chatId}
      `;
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

      const sourceChat = await this.getChat(sourceChatId);
      if (!sourceChat) {
        throw new Error(`Chat ${sourceChatId} does not exist.`);
      }

      await db.sql`
        UPDATE chats
        SET
          system_prompt = ${sourceChat.system_prompt},
          model = ${sourceChat.model},
          respond_on_any = ${sourceChat.respond_on_any},
          respond_on_mention = ${sourceChat.respond_on_mention},
          respond_on_reply = ${sourceChat.respond_on_reply},
          respond_on = ${sourceChat.respond_on},
          debug = ${sourceChat.debug},
          media_to_text_models = ${JSON.stringify(sourceChat.media_to_text_models ?? {})}::jsonb,
          model_roles = ${JSON.stringify(sourceChat.model_roles ?? {})}::jsonb,
          memory = ${sourceChat.memory},
          memory_threshold = ${sourceChat.memory_threshold},
          enabled_actions = ${JSON.stringify(sourceChat.enabled_actions ?? [])}::jsonb,
          active_persona = ${sourceChat.active_persona},
          harness = ${sourceChat.harness},
          output_visibility = ${JSON.stringify(sourceChat.output_visibility ?? {})}::jsonb,
          harness_config = ${JSON.stringify(sourceChat.harness_config ?? {})}::jsonb
        WHERE chat_id = ${targetChatId}
      `;
    },

    /**
     * Save the current harness session for a chat, or clear it when null.
     * @param {ChatRow["chat_id"]} chatId
     * @param {HarnessSessionRef | null} session
     * @returns {Promise<void>}
     */
    async saveHarnessSession(chatId, session) {
      await db.sql`
        UPDATE chats
        SET harness_session_id = ${session?.id ?? null},
            harness_session_kind = ${session?.kind ?? null}
        WHERE chat_id = ${chatId}
      `;
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
      const chat = await this.getChat(chatId);
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

      await db.sql`
        UPDATE chats
        SET harness_session_history = ${JSON.stringify(updated)},
            harness_session_id = NULL,
            harness_session_kind = NULL
        WHERE chat_id = ${chatId}
      `;
      return entry;
    },

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<HarnessSessionHistoryEntry[]>}
     */
    async getHarnessSessionHistory(chatId) {
      const chat = await this.getChat(chatId);
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
      const chat = await this.getChat(chatId);
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

      await db.sql`
        UPDATE chats
        SET harness_session_id = ${entry.id},
            harness_session_kind = ${entry.kind},
            harness_session_history = ${JSON.stringify(history)}
        WHERE chat_id = ${chatId}
      `;
      return entry;
    },

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<HarnessForkStackEntry[]>}
     */
    async getHarnessForkStack(chatId) {
      const chat = await this.getChat(chatId);
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
      const chat = await this.getChat(chatId);
      const stack = normalizeHarnessForkStack(chat?.harness_fork_stack);
      const normalizedEntry = normalizeHarnessForkStackEntry(entry);
      if (!normalizedEntry) {
        throw new Error("Invalid harness fork stack entry");
      }

      await db.sql`
        UPDATE chats
        SET harness_fork_stack = ${JSON.stringify([...stack, normalizedEntry])}
        WHERE chat_id = ${chatId}
      `;
    },

    /**
     * @param {ChatRow["chat_id"]} chatId
     * @returns {Promise<HarnessForkStackEntry | null>}
     */
    async popHarnessForkStack(chatId) {
      const chat = await this.getChat(chatId);
      const stack = normalizeHarnessForkStack(chat?.harness_fork_stack);
      const entry = stack.pop() ?? null;

      await db.sql`
        UPDATE chats
        SET harness_fork_stack = ${JSON.stringify(stack)}
        WHERE chat_id = ${chatId}
      `;
      return entry;
    },
  };
}
