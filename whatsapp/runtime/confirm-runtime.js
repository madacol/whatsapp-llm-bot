import { createSelectRuntime } from "./select-runtime.js";

/**
 * Confirmation runtime for WhatsApp polls.
 */

/**
 * @typedef {WhatsAppPollSocketPort | (() => WhatsAppPollSocketPort | null)} SocketResolver
 */

/**
 * @typedef {{ chatId: string, pollMsgId: string, selectedOptions: string[] }} ConfirmPollVoteEvent
 */

/**
 * @typedef {{
 *   handleReactions: (reactions: Array<{ key: { id: string; remoteJid: string }; reaction: { text: string } }>, sock: WhatsAppPollSocketPort) => void;
 *   handlePollVote: (event: ConfirmPollVoteEvent) => boolean;
 *   observePollCreationMessage: (message: import('@whiskeysockets/baileys').WAMessage) => boolean;
 *   resolvePollVoteMessage: (message: import('@whiskeysockets/baileys').WAMessage, sock: WhatsAppPollSocketPort) => Promise<ConfirmPollVoteEvent | null>;
 *   resolvePollUpdate: (update: import('@whiskeysockets/baileys').WAMessageUpdate, sock: WhatsAppPollSocketPort) => Promise<ConfirmPollVoteEvent | null>;
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

    observePollCreationMessage(message) {
      return pollRuntime.observePollCreationMessage(message);
    },

    resolvePollVoteMessage(message, sock) {
      return pollRuntime.resolvePollVoteMessage(message, sock);
    },

    resolvePollUpdate(update, sock) {
      return pollRuntime.resolvePollUpdate(update, sock);
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
