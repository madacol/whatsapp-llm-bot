/**
 * Reaction runtime for outbound message handles.
 */

/**
 * @typedef {(emoji: string, senderId: string) => void} ReactionCallback
 */

/**
 * @typedef {{
 *   subscribe: (msgKeyId: string, callback: ReactionCallback) => () => void;
 *   handleReactions: (reactions: Array<{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string }>) => void;
 *   clear: () => void;
 *   readonly size: number;
 * }} ReactionRuntime
 */

/**
 * Create a runtime that routes reactions to message handles.
 * Uses a Map<msgKeyId, Set<callback>> so multiple subscribers can coexist.
 * @returns {ReactionRuntime}
 */
export function createReactionRuntime() {
  /** @type {Map<string, Set<ReactionCallback>>} */
  const listeners = new Map();

  return {
    /**
     * Subscribe to reactions on a specific message.
     * @param {string} msgKeyId
     * @param {ReactionCallback} callback
     * @returns {() => void}
     */
    subscribe(msgKeyId, callback) {
      let callbacks = listeners.get(msgKeyId);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(msgKeyId, callbacks);
      }

      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          listeners.delete(msgKeyId);
        }
      };
    },

    /**
     * Route incoming reactions to registered callbacks.
     * @param {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string }>} reactions
     */
    handleReactions(reactions) {
      for (const { key, reaction, senderId } of reactions) {
        const callbacks = listeners.get(key.id);
        if (!callbacks) continue;

        for (const callback of callbacks) {
          callback(reaction.text, senderId);
        }
      }
    },

    get size() {
      return listeners.size;
    },

    clear() {
      listeners.clear();
    },
  };
}
