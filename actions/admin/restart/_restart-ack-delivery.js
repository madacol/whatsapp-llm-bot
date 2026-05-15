const RESTARTED_TEXT = "Restarted.";

/**
 * Deliver the pending post-restart acknowledgement, if one exists.
 * @param {{
 *   store: import("./_restart-ack-store.js").RestartAckStore,
 *   editMessage: (input: { chatId: string, keyId: string, text: string, isImage?: boolean }) => Promise<void>,
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
  const keyId = record.keyId ?? recoveredHandle?.keyId;
  const isImage = record.keyId ? record.isImage === true : recoveredHandle?.isImage === true;

  if (keyId) {
    await editMessage({
      chatId: record.chatId,
      keyId,
      text: RESTARTED_TEXT,
      isImage,
    });
  } else if (record.queueId) {
    return;
  } else {
    await sendText(record.chatId, RESTARTED_TEXT);
  }
  await store.clear();
}

export { RESTARTED_TEXT };
