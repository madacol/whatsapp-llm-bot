import { createSelectRuntime } from "./select-runtime.js";

/**
 * Confirmation runtime for WhatsApp polls.
 */

/**
 * @typedef {import('@whiskeysockets/baileys').WASocket | (() => import('@whiskeysockets/baileys').WASocket | null)} SocketResolver
 */

/**
 * @typedef {{ chatId: string, pollMsgId: string, selectedOptions: string[] }} ConfirmPollVoteEvent
 */

/**
 * @typedef {{
 *   handleReactions: (reactions: Array<{ key: { id: string; remoteJid: string }; reaction: { text: string } }>, sock: import('@whiskeysockets/baileys').WASocket) => void;
 *   handlePollVote: (event: ConfirmPollVoteEvent) => boolean;
 *   resolvePollVoteMessage: (message: import('@whiskeysockets/baileys').WAMessage, sock: import('@whiskeysockets/baileys').WASocket) => Promise<ConfirmPollVoteEvent | null>;
 *   createConfirm: (sock: SocketResolver, chatId: string) => (message: string, hooks?: ConfirmHooks) => Promise<boolean>;
 *   readonly size: number;
 *   clear: () => void;
 * }} ConfirmRuntime
 */

/**
 * Create a poll-backed confirmation runtime.
 * @returns {ConfirmRuntime}
 */
export function createConfirmRuntime() {
  const pollRuntime = createSelectRuntime();

  return {
    handleReactions() {},

    handlePollVote(event) {
      return pollRuntime.handlePollVote(event);
    },

    resolvePollVoteMessage(message, sock) {
      return pollRuntime.resolvePollVoteMessage(message, sock);
    },

    createConfirm(sock, chatId) {
      return pollRuntime.createConfirm(sock, chatId);
    },

    get size() {
      return pollRuntime.size;
    },

    clear() {
      pollRuntime.clear();
    },
  };
}
