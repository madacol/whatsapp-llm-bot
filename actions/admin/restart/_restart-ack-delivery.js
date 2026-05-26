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
 *   editMessage: (input: { transportHandleId: string, text: string }) => Promise<void>,
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

  const recoveredHandle = record.transportHandleId || record.keyId
    ? undefined
    : typeof record.queueId === "number"
      ? recoverQueuedMessage?.({ chatId: record.chatId, queueId: record.queueId })
      : undefined;
  const transportHandleId = record.transportHandleId ?? recoveredHandle?.transportHandleId;

  if (transportHandleId) {
    await editMessage({
      transportHandleId,
      text: RESTARTED_TEXT,
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
