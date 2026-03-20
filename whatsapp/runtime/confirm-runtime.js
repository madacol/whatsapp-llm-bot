/**
 * Confirmation runtime for WhatsApp reactions.
 */

/**
 * @typedef {{
 *   handleReactions: (reactions: Array<{ key: { id: string; remoteJid: string }; reaction: { text: string } }>, sock: import('@whiskeysockets/baileys').WASocket) => void;
 *   createConfirm: (sock: import('@whiskeysockets/baileys').WASocket, chatId: string) => (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
 *   readonly size: number;
 *   clear: () => void;
 * }} ConfirmRuntime
 */

/**
 * @typedef {{
 *   resolve: (value: boolean) => void;
 *   rawKey: import('@whiskeysockets/baileys').WAMessageKey;
 *   msgKey: { id: string; remoteJid: string };
 *   chatId: string;
 *   hooks?: ConfirmHooks;
 *   timer: ReturnType<typeof setTimeout>;
 * }} PendingConfirm
 */

/** Safety-net timeout: auto-reject after 30 minutes of no reaction. */
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Create a registry that routes reactions to pending confirmations.
 * Uses a single Map instead of per-confirm event listeners, so there is
 * exactly zero risk of listener accumulation.
 *
 * Lifecycle: create once per connection; on reconnect the same runtime
 * is reused because message IDs are globally unique.
 * @returns {ConfirmRuntime}
 */
export function createConfirmRuntime() {
  /** @type {Map<string, PendingConfirm>} */
  const pending = new Map();

  return {
    /**
     * Route incoming reactions to any matching pending confirmation.
     * Called once per batch from the socket-level event handler.
     * @param {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string } }>} reactions
     * @param {import('@whiskeysockets/baileys').WASocket} sock
     */
    handleReactions(reactions, sock) {
      for (const { key, reaction } of reactions) {
        const entry = pending.get(key.id);
        if (!entry) continue;

        /** @type {boolean | null} */
        let confirmed = null;
        /** @type {string} */
        let emoji = "";

        if (reaction.text?.startsWith("👍")) {
          confirmed = true;
          emoji = "✅";
        } else if (reaction.text?.startsWith("👎")) {
          confirmed = false;
          emoji = "❌";
        }

        if (confirmed === null) continue;

        clearTimeout(entry.timer);
        pending.delete(key.id);
        sock.sendMessage(entry.chatId, { react: { text: emoji, key: entry.rawKey } });
        entry.hooks?.onResolved?.(entry.msgKey, confirmed);
        entry.resolve(confirmed);
      }
    },

    /**
     * Create a confirm function scoped to a chat.
     * @param {import('@whiskeysockets/baileys').WASocket} sock
     * @param {string} chatId
     * @returns {(message: string, hooks?: ConfirmHooks) => Promise<boolean>}
     */
    createConfirm(sock, chatId) {
      return async (message, hooks) => {
        const sentMsg = await sock.sendMessage(chatId, { text: message });
        if (!sentMsg) return false;

        const rawKey = sentMsg.key;
        if (!rawKey.id || !rawKey.remoteJid) return false;

        /** @type {{ id: string; remoteJid: string }} */
        const msgKey = { id: rawKey.id, remoteJid: rawKey.remoteJid };

        sock.sendMessage(chatId, {
          react: { text: "⏳", key: rawKey },
        });

        if (hooks?.onSent) {
          await hooks.onSent(msgKey);
        }

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(msgKey.id);
            sock.sendMessage(chatId, { react: { text: "⌛", key: rawKey } });
            resolve(false);
          }, CONFIRM_TIMEOUT_MS);

          pending.set(msgKey.id, { resolve, rawKey, msgKey, chatId, hooks, timer });
        });
      };
    },

    get size() {
      return pending.size;
    },

    clear() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(false);
      }
      pending.clear();
    },
  };
}
