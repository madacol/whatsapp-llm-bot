/**
 * @typedef {{
 *   command: "wait" | "send",
 *   trailingText: string,
 * }} WaitSendBatchCommand
 */

/**
 * @typedef {{
 *   content: IncomingContentBlock[],
 *   senderIds: string[],
 *   senderJids: string[],
 *   firstTurn: ChannelInput,
 *   messageCount: number,
 * }} WaitSendBatch
 */

/**
 * @param {string} text
 * @returns {WaitSendBatchCommand | null}
 */
export function parseWaitSendBatchCommandText(text) {
  const match = text.match(/^\/(wait|send)(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  const command = /** @type {"wait" | "send"} */ (match[1].toLowerCase());
  return {
    command,
    trailingText: match[2]?.trim() ?? "",
  };
}

/**
 * @param {ChannelInput} turn
 * @param {TextContentBlock} firstBlock
 * @param {WaitSendBatchCommand} command
 * @returns {IncomingContentBlock[]}
 */
export function stripWaitSendCommandContent(turn, firstBlock, command) {
  const firstTextIndex = turn.content.indexOf(firstBlock);
  if (firstTextIndex === -1) {
    return [];
  }

  /** @type {IncomingContentBlock[]} */
  const content = [];
  for (let index = 0; index < turn.content.length; index += 1) {
    const block = turn.content[index];
    if (index === firstTextIndex) {
      if (command.trailingText) {
        content.push({ type: "text", text: command.trailingText });
      }
      continue;
    }
    content.push(block);
  }
  return content;
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
 * @returns {void}
 */
function appendToBatch(batch, turn, content) {
  if (content.length === 0) {
    return;
  }
  batch.content.push(...content);
  batch.senderIds = unique([...batch.senderIds, ...turn.senderIds]);
  batch.senderJids = unique([...batch.senderJids, ...(turn.senderJids ?? [])]);
  batch.messageCount += 1;
}

/**
 * @returns {{
 *   has: (chatId: string) => boolean,
 *   startOrAppend: (turn: ChannelInput, content: IncomingContentBlock[]) => { alreadyOpen: boolean, messageCount: number },
 *   append: (turn: ChannelInput, content: IncomingContentBlock[]) => { messageCount: number },
 *   commit: (turn: ChannelInput, content: IncomingContentBlock[]) => ChannelInput | null,
 * }}
 */
export function createWaitSendBatchStore() {
  /** @type {Map<string, WaitSendBatch>} */
  const batches = new Map();

  return {
    has(chatId) {
      return batches.has(chatId);
    },

    startOrAppend(turn, content) {
      const existing = batches.get(turn.chatId);
      if (existing) {
        appendToBatch(existing, turn, content);
        return { alreadyOpen: true, messageCount: existing.messageCount };
      }

      /** @type {WaitSendBatch} */
      const batch = {
        content: [],
        senderIds: [...turn.senderIds],
        senderJids: [...(turn.senderJids ?? [])],
        firstTurn: turn,
        messageCount: 0,
      };
      appendToBatch(batch, turn, content);
      batches.set(turn.chatId, batch);
      return { alreadyOpen: false, messageCount: batch.messageCount };
    },

    append(turn, content) {
      const batch = batches.get(turn.chatId);
      if (!batch) {
        throw new Error(`No wait/send batch is open for chat ${turn.chatId}.`);
      }
      appendToBatch(batch, turn, content);
      return { messageCount: batch.messageCount };
    },

    commit(turn, content) {
      const batch = batches.get(turn.chatId);
      if (!batch) {
        return null;
      }
      appendToBatch(batch, turn, content);
      batches.delete(turn.chatId);
      if (batch.content.length === 0) {
        return null;
      }
      return {
        ...turn,
        senderIds: unique([...batch.senderIds, ...turn.senderIds]),
        senderJids: unique([...batch.senderJids, ...(turn.senderJids ?? [])]),
        content: [...batch.content],
        timestamp: batch.firstTurn.timestamp,
        facts: {
          ...turn.facts,
          addressedToBot: true,
        },
      };
    },
  };
}
