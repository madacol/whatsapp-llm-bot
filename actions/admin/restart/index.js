import { createRestartAckStore } from "./_restart-ack-store.js";
import { listActiveHarnessSessions, waitForAllHarnesses } from "#harnesses";
import { textUpdate } from "../../../outbound-events.js";
import { defaultRestartGate } from "../../../restart-gate.js";

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
 * @typedef {{
 *   listActiveTurns: () => import("./_restart-ack-store.js").RestartInterruptedTurn[],
 *   waitForIdle: () => Promise<import("./_restart-ack-store.js").RestartInterruptedTurn[]>,
 *   beginWaiting?: () => void,
 * }} RestartRuntime
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
 * @param {() => void} [restartScheduler]
 * @param {import("./_restart-ack-store.js").RestartAckStore} [restartAckStore]
 * @param {RestartRuntime} [restartRuntime]
 * @returns {Action}
 */
export function createRestartAction(
  restartScheduler = scheduleRestart,
  restartAckStore = createRestartAckStore(),
  restartRuntime = createDefaultRestartRuntime(),
) {
  return defineLocalAction({
  name: "restart",
  command: "restart",
  description: "Restart the bot process",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        description: "Use --force to restart immediately and mark active turns as interrupted.",
        default: "",
      },
    },
    required: [],
  },
  formatToolCall: () => "Restarting bot…",
  permissions: {
    requireMaster: true,
    autoExecute: true,
    autoContinue: false,
  },
  action_fn: async function (context, params = {}) {
    return {
      result: "Restart signal sent.",
      autoContinue: false,
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
            ...(sentHandle.transportHandleId ? { transportHandleId: sentHandle.transportHandleId } : {}),
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
  },
  });
}

export default createRestartAction();
