import { createRestartAckStore } from "./_restart-ack-store.js";

const RESTART_DELAY_MS = 750;
const RESTART_ACK_TIMEOUT_MS = 10_000;

/**
 * @template {Action} T
 * @param {T} action
 * @returns {T}
 */
function defineLocalAction(action) {
  return action;
}

/**
 * @typedef {{ unref: () => void }} RestartTimer
 * @typedef {(pid: number, signal: NodeJS.Signals) => void} RestartKillFn
 * @typedef {(callback: () => void, delayMs: number) => RestartTimer} RestartSetTimeoutFn
 */

/**
 * Schedule a restart after the current action has had time to return its result
 * to the chat runtime.
 * @param {{
 *   pid?: number,
 *   delayMs?: number,
 *   killFn?: RestartKillFn,
 *   setTimeoutFn?: RestartSetTimeoutFn,
 * }} [options]
 * @returns {void}
 */
export function scheduleRestart(options = {}) {
  const {
    pid = process.pid,
    delayMs = RESTART_DELAY_MS,
    killFn = process.kill,
    setTimeoutFn = setTimeout,
  } = options;

  const timer = setTimeoutFn(() => {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid restart PID: ${pid}`);
    }
    killFn(pid, "SIGTERM");
  }, Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : RESTART_DELAY_MS);
  timer.unref();
}

/**
 * @param {() => void} [restartScheduler]
 * @param {import("./_restart-ack-store.js").RestartAckStore} [restartAckStore]
 * @returns {Action}
 */
export function createRestartAction(restartScheduler = scheduleRestart, restartAckStore = createRestartAckStore()) {
  return defineLocalAction({
  name: "restart",
  command: "restart",
  description: "Restart the bot process",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  formatToolCall: () => "Restarting bot…",
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: false,
  },
  action_fn: async function (context) {
    return {
      result: "Restart signal sent.",
      autoContinue: false,
      afterResponse: async ({ handle } = {}) => {
        await restartAckStore.save({
          chatId: context.chatId,
          requestedAt: new Date().toISOString(),
          oldPid: process.pid,
          ...(handle?.queueId ? { queueId: handle.queueId } : {}),
        });
        const sentHandle = await handle?.waitUntilSent?.({ timeoutMs: RESTART_ACK_TIMEOUT_MS });
        if (sentHandle?.keyId) {
          await restartAckStore.save({
            chatId: context.chatId,
            requestedAt: new Date().toISOString(),
            oldPid: process.pid,
            keyId: sentHandle.keyId,
            isImage: sentHandle.isImage === true,
            ...(handle?.queueId ? { queueId: handle.queueId } : {}),
          });
        }
        restartScheduler();
      },
    };
  },
  });
}

export default createRestartAction();
