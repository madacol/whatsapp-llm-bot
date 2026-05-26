const RESTARTED_TEXT = "Restarted.";

/**
 * @param {import("./_restart-ack-store.js").RestartInterruptedTurn} turn
 * @returns {string}
 */
function formatInterruptedTurnMessage(turn) {
  const label = turn.label ? `${turn.label} ` : "";
  return `Previous ${label}turn was interrupted by restart before it completed. No final result was produced.`;
}

/**
 * Deliver the pending post-restart acknowledgement, if one exists.
 * @param {{
 *   store: import("./_restart-ack-store.js").RestartAckStore,
 *   editMessage: (input: { chatId: string, text: string, keyId?: string, editToken?: unknown }) => Promise<void>,
 *   sendText: (chatId: string, text: string) => Promise<void>,
 *   recoverQueuedMessage?: (input: { chatId: string, queueId: number }) => MessageHandle | undefined,
 * }} input
 * @returns {Promise<void>}
 */
export async function deliverPendingRestartAck({ store, editMessage, sendText, recoverQueuedMessage }) {
  const record = await store.read();
  if (!record) {
    return;
  }

  const recoveredHandle = record.keyId
    ? undefined
    : typeof record.queueId === "number"
      ? recoverQueuedMessage?.({ chatId: record.chatId, queueId: record.queueId })
      : undefined;
  const editToken = record.editToken ?? recoveredHandle?.editToken;
  const keyId = record.keyId ?? recoveredHandle?.keyId;

  if (editToken !== undefined || keyId) {
    await editMessage({
      chatId: record.chatId,
      text: RESTARTED_TEXT,
      ...(editToken !== undefined ? { editToken } : {}),
      ...(keyId ? { keyId } : {}),
    });
  } else if (record.queueId) {
    return;
  } else {
    await sendText(record.chatId, RESTARTED_TEXT);
  }
  for (const turn of record.interruptedTurns ?? []) {
    await sendText(turn.chatId, formatInterruptedTurnMessage(turn));
  }
  await store.clear();
}

export { RESTARTED_TEXT };
