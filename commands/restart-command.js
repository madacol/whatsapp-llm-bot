import config from "../config.js";
import { createRestartAckStore } from "../restart/restart-ack-store.js";
import { listActiveHarnessSessions, waitForAllHarnesses } from "#harnesses";
import { textUpdate } from "../outbound-events.js";
import { defaultRestartGate } from "../restart-gate.js";
import { scheduleRestart } from "../restart/restart-scheduler.js";

const RESTART_ACK_TIMEOUT_MS = 10_000;

export const RESTART_COMMAND_PARAMETERS = /** @type {CommandParametersSchema} */ ({
  type: "object",
  properties: {
    mode: { type: "string", default: "" },
  },
  required: [],
});

/**
 * @typedef {{
 *   listActiveTurns: () => import("../restart/restart-ack-store.js").RestartInterruptedTurn[],
 *   waitForIdle: () => Promise<import("../restart/restart-ack-store.js").RestartInterruptedTurn[]>,
 *   beginWaiting?: () => void,
 * }} RestartRuntime
 */

/**
 * @returns {RestartRuntime}
 */
function createDefaultRestartRuntime() {
  return {
    listActiveTurns: listActiveHarnessSessions,
    async waitForIdle() {
      return waitForAllHarnesses().then((chatIds) => chatIds.map((chatId) => ({ chatId })));
    },
    beginWaiting: () => {
      defaultRestartGate.beginWaiting();
    },
  };
}

/**
 * @param {unknown} params
 * @returns {boolean}
 */
function isForcedRestart(params) {
  if (params == null || typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  const mode = /** @type {{ mode?: unknown }} */ (params).mode;
  return typeof mode === "string" && ["force", "--force"].includes(mode.trim().toLowerCase());
}

/**
 * @param {number} count
 * @returns {string}
 */
function formatRestartWaitMessage(count) {
  return `Restart queued; waiting for ${count} active turn${count === 1 ? "" : "s"} to finish.`;
}

/**
 * @param {{
 *   restartScheduler?: () => void,
 *   restartAckStore?: import("../restart/restart-ack-store.js").RestartAckStore,
 *   restartRuntime?: RestartRuntime,
 * }} [options]
 * @returns {(context: Pick<ExecuteActionContext, "chatId" | "senderIds">, params?: Record<string, unknown>) => Promise<{ result: string, afterResponse: (input?: { handle?: MessageHandle }) => Promise<void> }>}
 */
export function createRestartCommandHandler(options = {}) {
  const restartScheduler = options.restartScheduler ?? scheduleRestart;
  const restartAckStore = options.restartAckStore ?? createRestartAckStore();
  const restartRuntime = options.restartRuntime ?? createDefaultRestartRuntime();

  return async function runRestartCommand(context, params = {}) {
    if (!context.senderIds.some((senderId) => config.MASTER_IDs.includes(senderId))) {
      throw new Error("Restart requires master permissions");
    }
    return {
      result: "Restart signal sent.",
      afterResponse: async ({ handle } = {}) => {
        const forced = isForcedRestart(params);
        const activeTurns = restartRuntime.listActiveTurns();
        const interruptedTurns = forced ? activeTurns : [];
        if (!forced && activeTurns.length > 0) {
          restartRuntime.beginWaiting?.();
          await handle?.update(textUpdate(formatRestartWaitMessage(activeTurns.length)));
        }
        await restartAckStore.save({
          chatId: context.chatId,
          requestedAt: new Date().toISOString(),
          oldPid: process.pid,
          ...(handle?.queueId ? { queueId: handle.queueId } : {}),
          ...(interruptedTurns.length > 0 ? { interruptedTurns } : {}),
        });
        const sentHandle = await handle?.waitUntilSent?.({ timeoutMs: RESTART_ACK_TIMEOUT_MS });
        if (sentHandle?.transportHandleId) {
          await restartAckStore.save({
            chatId: context.chatId,
            requestedAt: new Date().toISOString(),
            oldPid: process.pid,
            transportHandleId: sentHandle.transportHandleId,
            ...(handle?.queueId ? { queueId: handle.queueId } : {}),
            ...(interruptedTurns.length > 0 ? { interruptedTurns } : {}),
          });
        }
        if (!forced && activeTurns.length > 0) {
          await restartRuntime.waitForIdle();
        }
        restartScheduler();
      },
    };
  };
}
