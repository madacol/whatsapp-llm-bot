import { createLogger } from "../logger.js";

const RESTARTED_TEXT = "Restarted.";
const log = createLogger("restart");

/**
 * @param {import("./restart-ack-store.js").RestartInterruptedTurn} turn
 * @returns {string}
 */
function formatInterruptedTurnMessage(turn) {
  const label = turn.label ? `${turn.label} ` : "";
  return `Previous ${label}turn was interrupted by restart before it completed. No final result was produced.`;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnavailableEditHandleError(error) {
  return error instanceof Error
    && (
      /^WhatsApp edit handle .+ was not found\.$/.test(error.message)
      || /^WhatsApp edit handle .+ expired\.$/.test(error.message)
    );
}

/**
 * Deliver the pending post-restart acknowledgement, if one exists.
 * @param {{
 *   store: import("./restart-ack-store.js").RestartAckStore,
 *   editMessage: (input: { transportHandleId: string, text: string }) => Promise<void>,
 *   sendText: (chatId: string, text: string) => Promise<void>,
 *   recoverQueuedMessage?: (input: { chatId: string, queueId: number }) => MessageHandle | undefined,
 *   phase?: "beforeQueueFlush" | "afterQueueFlush",
 *   log?: Pick<ReturnType<typeof createLogger>, "info" | "warn">,
 * }} input
 * @returns {Promise<void>}
 */
export async function deliverPendingRestartAck({ store, editMessage, sendText, recoverQueuedMessage, phase, log: restartLog = log }) {
  const record = await store.read();
  if (!record) {
    restartLog.info("No pending restart acknowledgement found.", {
      phase: phase ?? null,
    });
    return;
  }
  restartLog.info("Pending restart acknowledgement found.", {
    restartId: record.restartId ?? null,
    chatId: record.chatId,
    oldPid: record.oldPid,
    currentPid: process.pid,
    phase: phase ?? null,
    hasTransportHandleId: !!record.transportHandleId,
    hasLegacyKeyId: !!record.keyId,
    queueId: record.queueId ?? null,
    interruptedTurnCount: record.interruptedTurns?.length ?? 0,
  });

  const recoveredHandle = record.transportHandleId || record.keyId
    ? undefined
    : typeof record.queueId === "number"
      ? recoverQueuedMessage?.({ chatId: record.chatId, queueId: record.queueId })
      : undefined;
  const transportHandleId = record.transportHandleId ?? recoveredHandle?.transportHandleId;

  if (!transportHandleId && phase === "beforeQueueFlush" && typeof record.queueId === "number") {
    restartLog.info("Deferring restart acknowledgement until queued message can be recovered.", {
      restartId: record.restartId ?? null,
      chatId: record.chatId,
      queueId: record.queueId,
      phase,
    });
    return;
  }

  if (transportHandleId) {
    try {
      await editMessage({
        transportHandleId,
        text: RESTARTED_TEXT,
      });
      restartLog.info("Restart acknowledgement edited.", {
        restartId: record.restartId ?? null,
        chatId: record.chatId,
        transportHandleId,
      });
    } catch (error) {
      if (!isUnavailableEditHandleError(error)) {
        throw error;
      }
      restartLog.warn("Sending fallback restart acknowledgement because the WhatsApp edit handle is unavailable.", {
        restartId: record.restartId ?? null,
        chatId: record.chatId,
        transportHandleId,
      });
      await sendText(record.chatId, RESTARTED_TEXT);
    }
  } else {
    restartLog.warn("Sending fallback restart acknowledgement because no editable message handle was available.", {
      restartId: record.restartId ?? null,
      chatId: record.chatId,
      ...(record.queueId ? { queueId: record.queueId } : {}),
    });
    await sendText(record.chatId, RESTARTED_TEXT);
  }
  for (const turn of record.interruptedTurns ?? []) {
    restartLog.info("Sending restart interrupted-turn notice.", {
      restartId: record.restartId ?? null,
      chatId: turn.chatId,
      label: turn.label ?? null,
    });
    await sendText(turn.chatId, formatInterruptedTurnMessage(turn));
  }
  await store.clear();
  restartLog.info("Restart acknowledgement marker cleared.", {
    restartId: record.restartId ?? null,
    chatId: record.chatId,
  });
}

export { RESTARTED_TEXT };
