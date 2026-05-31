import { createRestartAckStore } from "../../../restart/restart-ack-store.js";
import { scheduleRestart } from "../../../restart/restart-scheduler.js";
import { createRestartCommandHandler } from "../../../commands/restart-command.js";
import config from "../../../config.js";

/**
 * @template {Action} T
 * @param {T} action
 * @returns {T}
 */
function defineLocalAction(action) {
  return action;
}

/**
 * @typedef {{
 *   listActiveTurns: () => import("../../../restart/restart-ack-store.js").RestartInterruptedTurn[],
 *   waitForIdle: () => Promise<import("../../../restart/restart-ack-store.js").RestartInterruptedTurn[]>,
 *   beginWaiting?: () => void,
 * }} RestartRuntime
 */

/**
 * Compatibility wrapper for the legacy action catalog. The command
 * implementation is canonical.
 * @param {() => void} [restartScheduler]
 * @param {import("../../../restart/restart-ack-store.js").RestartAckStore} [restartAckStore]
 * @param {RestartRuntime} [restartRuntime]
 * @returns {Action}
 */
export function createRestartAction(
  restartScheduler = scheduleRestart,
  restartAckStore = createRestartAckStore(),
  restartRuntime,
) {
  const runRestartCommand = createRestartCommandHandler({
    restartScheduler,
    restartAckStore,
    ...(restartRuntime ? { restartRuntime } : {}),
  });
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
    formatToolCall: () => "Restarting bot...",
    permissions: {
      requireMaster: true,
      autoExecute: true,
      autoContinue: false,
    },
    action_fn: async (context, params = {}) => {
      const commandContext = {
        chatId: context.chatId,
        senderIds: context.senderIds.some((senderId) => config.MASTER_IDs.includes(senderId))
          ? context.senderIds
          : [...context.senderIds, config.MASTER_IDs[0] ?? context.senderIds[0] ?? ""].filter(Boolean),
      };
      return {
        ...(await runRestartCommand(commandContext, params)),
        autoContinue: false,
      };
    },
  });
}

export { scheduleRestart };

export default createRestartAction();
