import { randomUUID } from "node:crypto";
import config from "../config.js";
import { createRestartAckStore } from "../restart/restart-ack-store.js";
import { listActiveHarnessSessions, waitForAllHarnesses } from "#harnesses";
import { textUpdate } from "../message-handle-events.js";
import { defaultRestartGate } from "../restart-gate.js";
import { scheduleRestart } from "../restart/restart-scheduler.js";
import { createLogger } from "../logger.js";

const RESTART_ACK_TIMEOUT_MS = 10_000;
const log = createLogger("restart");

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
 *   restartScheduler?: (input?: { restartId?: string }) => void,
 *   restartAckStore?: import("../restart/restart-ack-store.js").RestartAckStore,
 *   restartRuntime?: RestartRuntime,
 *   createRestartId?: () => string,
 *   log?: Pick<ReturnType<typeof createLogger>, "info" | "warn" | "error">,
 * }} [options]
 * @returns {(context: Pick<ExecuteActionContext, "chatId" | "senderIds">, params?: Record<string, unknown>) => Promise<{ result: string, afterResponse: (input?: { handle?: MessageHandle }) => Promise<void> }>}
 */
export function createRestartCommandHandler(options = {}) {
  const restartScheduler = options.restartScheduler ?? scheduleRestart;
  const restartAckStore = options.restartAckStore ?? createRestartAckStore();
  const restartRuntime = options.restartRuntime ?? createDefaultRestartRuntime();
  const createRestartId = options.createRestartId ?? randomUUID;
  const restartLog = options.log ?? log;

  return async function runRestartCommand(context, params = {}) {
    if (!context.senderIds.some((senderId) => config.MASTER_IDs.includes(senderId))) {
      throw new Error("Restart requires master permissions");
    }
    return {
      result: "Restart signal sent.",
      afterResponse: async ({ handle } = {}) => {
        const restartId = createRestartId();
        const requestedAt = new Date().toISOString();
        const forced = isForcedRestart(params);
        const activeTurns = restartRuntime.listActiveTurns();
        const interruptedTurns = forced ? activeTurns : [];
        restartLog.info("Restart command accepted.", {
          restartId,
          chatId: context.chatId,
          oldPid: process.pid,
          forced,
          activeTurnCount: activeTurns.length,
          activeTurns,
          hasMessageHandle: !!handle,
          queueId: handle?.queueId ?? null,
        });
        if (!forced && activeTurns.length > 0) {
          restartRuntime.beginWaiting?.();
          restartLog.info("Restart waiting for active turns.", {
            restartId,
            chatId: context.chatId,
            activeTurnCount: activeTurns.length,
            activeTurns,
          });
          await handle?.update(textUpdate(formatRestartWaitMessage(activeTurns.length)));
        }
        await restartAckStore.save({
          restartId,
          chatId: context.chatId,
          requestedAt,
          oldPid: process.pid,
          ...(handle?.queueId ? { queueId: handle.queueId } : {}),
          ...(interruptedTurns.length > 0 ? { interruptedTurns } : {}),
        });
        restartLog.info("Restart ack marker saved.", {
          restartId,
          chatId: context.chatId,
          hasTransportHandleId: false,
          queueId: handle?.queueId ?? null,
          interruptedTurnCount: interruptedTurns.length,
        });
        const sentHandle = await handle?.waitUntilSent?.({ timeoutMs: RESTART_ACK_TIMEOUT_MS });
        if (sentHandle?.transportHandleId) {
          await restartAckStore.save({
            restartId,
            chatId: context.chatId,
            requestedAt,
            oldPid: process.pid,
            transportHandleId: sentHandle.transportHandleId,
            ...(handle?.queueId ? { queueId: handle.queueId } : {}),
            ...(interruptedTurns.length > 0 ? { interruptedTurns } : {}),
          });
          restartLog.info("Restart ack marker attached to sent transport handle.", {
            restartId,
            chatId: context.chatId,
            transportHandleId: sentHandle.transportHandleId,
            queueId: handle?.queueId ?? null,
          });
        } else {
          restartLog.warn("Restart ack marker has no sent transport handle before scheduling restart.", {
            restartId,
            chatId: context.chatId,
            queueId: handle?.queueId ?? null,
            hadWaitUntilSent: typeof handle?.waitUntilSent === "function",
          });
        }
        if (!forced && activeTurns.length > 0) {
          restartLog.info("Restart active turn wait starting.", {
            restartId,
            chatId: context.chatId,
            activeTurnCount: activeTurns.length,
          });
          const drainedTurns = await restartRuntime.waitForIdle();
          restartLog.info("Restart active turn wait completed.", {
            restartId,
            chatId: context.chatId,
            drainedTurnCount: drainedTurns.length,
            drainedTurns,
          });
        }
        restartLog.info("Restart scheduler invoked.", {
          restartId,
          chatId: context.chatId,
          oldPid: process.pid,
        });
        restartScheduler({ restartId });
      },
    };
  };
}
