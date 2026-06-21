import { randomUUID } from "node:crypto";
import config from "../config.js";
import { createRestartAckStore } from "../restart/restart-ack-store.js";
import { listActiveHarnessSessions } from "#harnesses";
import { scheduleRestart } from "../restart/restart-scheduler.js";
import { createLogger } from "../logger.js";

const RESTART_ACK_TIMEOUT_MS = 10_000;
const log = createLogger("restart");

export const RESTART_COMMAND_PARAMETERS = /** @type {CommandParametersSchema} */ ({
  type: "object",
  properties: {},
  required: [],
});

/**
 * @typedef {{
 *   listActiveTurns: () => import("../restart/restart-ack-store.js").RestartInterruptedTurn[],
 * }} RestartRuntime
 */

/**
 * @returns {RestartRuntime}
 */
function createDefaultRestartRuntime() {
  return {
    listActiveTurns: listActiveHarnessSessions,
  };
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

  return async function runRestartCommand(context, _params = {}) {
    if (!context.senderIds.some((senderId) => config.MASTER_IDs.includes(senderId))) {
      throw new Error("Restart requires master permissions");
    }
    return {
      result: "Restart signal sent.",
      afterResponse: async ({ handle } = {}) => {
        const restartId = createRestartId();
        const requestedAt = new Date().toISOString();
        const activeTurns = restartRuntime.listActiveTurns();
        restartLog.info("Restart command accepted.", {
          restartId,
          chatId: context.chatId,
          oldPid: process.pid,
          activeTurnCount: activeTurns.length,
          activeTurns,
          hasMessageHandle: !!handle,
          queueId: handle?.queueId ?? null,
        });
        await restartAckStore.save({
          restartId,
          chatId: context.chatId,
          requestedAt,
          oldPid: process.pid,
          ...(handle?.queueId ? { queueId: handle.queueId } : {}),
        });
        restartLog.info("Restart ack marker saved.", {
          restartId,
          chatId: context.chatId,
          hasTransportHandleId: false,
          queueId: handle?.queueId ?? null,
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
