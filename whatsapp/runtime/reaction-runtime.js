/**
 * Reaction runtime for outbound message handles.
 */

/**
 * @typedef {{ fromMe?: boolean, senderIds?: string[] }} ReactionMetadata
 */

/**
 * @typedef {(emoji: string, senderId: string, metadata: ReactionMetadata) => void} ReactionCallback
 */

/**
 * @typedef {{
 *   subscribe: (msgKeyId: string, callback: ReactionCallback) => () => void;
 *   handleReactions: (reactions: Array<{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string, senderIds?: string[], fromMe?: boolean }>) => void;
 *   clear: () => void;
 *   readonly size: number;
 * }} ReactionRuntime
 */

/**
 * @typedef {{
 *   type: "reaction.received";
 *   messageId: string;
 *   remoteJid: string;
 *   emoji: string;
 *   senderId: string;
 *   senderIds?: string[];
 *   fromMe?: boolean;
 *   listenerCount: number;
 * }} ReactionRuntimeObserverEvent
 */

/**
 * Create a runtime that routes reactions to message handles.
 * Uses a Map<msgKeyId, Set<callback>> so multiple subscribers can coexist.
 * @param {{ observer?: (event: ReactionRuntimeObserverEvent) => void }} [options]
 * @returns {ReactionRuntime}
 */
export function createReactionRuntime(options = {}) {
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
     * @param {Array<{ key: { id: string; remoteJid: string }; reaction: { text: string }; senderId: string, senderIds?: string[], fromMe?: boolean }>} reactions
     */
    handleReactions(reactions) {
      for (const { key, reaction, senderId, senderIds, fromMe } of reactions) {
        const callbacks = listeners.get(key.id);
        options.observer?.({
          type: "reaction.received",
          messageId: key.id,
          remoteJid: key.remoteJid,
          emoji: reaction.text,
          senderId,
          ...(senderIds !== undefined ? { senderIds } : {}),
          ...(fromMe !== undefined ? { fromMe } : {}),
          listenerCount: callbacks?.size ?? 0,
        });
        if (!callbacks) continue;

        for (const callback of callbacks) {
          callback(reaction.text, senderId, {
            ...(senderIds !== undefined ? { senderIds } : {}),
            ...(fromMe !== undefined ? { fromMe } : {}),
          });
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
