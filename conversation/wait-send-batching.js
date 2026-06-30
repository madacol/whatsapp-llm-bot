/**
 * @typedef {{
 *   command: "wait" | "send" | "cancel",
 * }} WaitSendBatchCommand
 */

/**
 * @typedef {{
 *   content: IncomingContentBlock[],
 *   inputTexts: string[],
 *   senderIds: string[],
 *   senderJids: string[],
 *   firstTurn: ChannelInput,
 *   messageCount: number,
 * }} WaitSendBatch
 */

/**
 * @typedef {{
 *   turn: ChannelInput,
 *   inputText: string,
 * }} WaitSendBatchCommit
 */

/**
 * @param {string} text
 * @returns {WaitSendBatchCommand | null}
 */
export function parseWaitSendBatchCommandText(text) {
  const match = text.match(/^\/(wait|send|cancel)(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  const command = /** @type {"wait" | "send" | "cancel"} */ (match[1].toLowerCase());
  return {
    command,
  };
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)];
}

/**
 * @param {WaitSendBatch} batch
 * @param {ChannelInput} turn
 * @param {IncomingContentBlock[]} content
 * @param {string} inputText
 * @returns {void}
 */
function appendToBatch(batch, turn, content, inputText) {
  if (content.length === 0 && !inputText) {
    return;
  }
  batch.content.push(...content);
  if (inputText) {
    batch.inputTexts.push(inputText);
  }
  batch.senderIds = unique([...batch.senderIds, ...turn.senderIds]);
  batch.senderJids = unique([...batch.senderJids, ...(turn.senderJids ?? [])]);
  batch.messageCount += 1;
}

/**
 * @returns {{
 *   has: (chatId: string) => boolean,
 *   startOrAppend: (turn: ChannelInput, content: IncomingContentBlock[], inputText?: string) => { alreadyOpen: boolean, messageCount: number },
 *   append: (turn: ChannelInput, content: IncomingContentBlock[], inputText: string) => { messageCount: number },
 *   commit: (turn: ChannelInput, content: IncomingContentBlock[], inputText?: string) => WaitSendBatchCommit | null,
 *   cancel: (chatId: string) => { messageCount: number } | null,
 * }}
 */
export function createWaitSendBatchStore() {
  /** @type {Map<string, WaitSendBatch>} */
  const batches = new Map();

  return {
    has(chatId) {
      return batches.has(chatId);
    },

    startOrAppend(turn, content, inputText = "") {
      const existing = batches.get(turn.chatId);
      if (existing) {
        appendToBatch(existing, turn, content, inputText);
        return { alreadyOpen: true, messageCount: existing.messageCount };
      }

      /** @type {WaitSendBatch} */
      const batch = {
        content: [],
        inputTexts: [],
        senderIds: [...turn.senderIds],
        senderJids: [...(turn.senderJids ?? [])],
        firstTurn: turn,
        messageCount: 0,
      };
      appendToBatch(batch, turn, content, inputText);
      batches.set(turn.chatId, batch);
      return { alreadyOpen: false, messageCount: batch.messageCount };
    },

    append(turn, content, inputText) {
      const batch = batches.get(turn.chatId);
      if (!batch) {
        throw new Error(`No wait/send batch is open for chat ${turn.chatId}.`);
      }
      appendToBatch(batch, turn, content, inputText);
      return { messageCount: batch.messageCount };
    },

    commit(turn, content, inputText = "") {
      const batch = batches.get(turn.chatId);
      if (!batch) {
        return null;
      }
      appendToBatch(batch, turn, content, inputText);
      batches.delete(turn.chatId);
      if (batch.content.length === 0) {
        return null;
      }
      return {
        turn: {
          ...turn,
          senderIds: unique([...batch.senderIds, ...turn.senderIds]),
          senderJids: unique([...batch.senderJids, ...(turn.senderJids ?? [])]),
          content: [...batch.content],
          timestamp: batch.firstTurn.timestamp,
          facts: {
            ...turn.facts,
            addressedToBot: true,
          },
        },
        inputText: batch.inputTexts.join("\n"),
      };
    },

    cancel(chatId) {
      const batch = batches.get(chatId);
      if (!batch) {
        return null;
      }
      batches.delete(chatId);
      return { messageCount: batch.messageCount };
    },
  };
}
