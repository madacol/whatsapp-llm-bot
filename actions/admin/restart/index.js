import { spawn } from "node:child_process";

const RESTART_DELAY_MS = 750;

/**
 * @template {Action} T
 * @param {T} action
 * @returns {T}
 */
function defineLocalAction(action) {
  return action;
}

/**
 * @typedef {(command: string, args: string[], options: {
 *   detached: true,
 *   stdio: "ignore",
 *   env: NodeJS.ProcessEnv,
 * }) => { unref: () => void }} RestartSpawnFn
 */

/**
 * Schedule a restart after the current action has had time to return its result
 * to the chat runtime.
 * @param {{
 *   pid?: number,
 *   delayMs?: number,
 *   spawnFn?: RestartSpawnFn,
 * }} [options]
 * @returns {void}
 */
export function scheduleRestart(options = {}) {
  const {
    pid = process.pid,
    delayMs = RESTART_DELAY_MS,
    spawnFn = spawn,
  } = options;

  const child = spawnFn(process.execPath, [
    "-e",
    [
      "const pid = Number(process.env.BOT_RESTART_PID);",
      "const delay = Number(process.env.BOT_RESTART_DELAY_MS);",
      "setTimeout(() => {",
      "  if (!Number.isInteger(pid) || pid <= 0) process.exit(1);",
      "  try {",
      "    process.kill(pid, 'SIGTERM');",
      "  } catch (error) {",
      "    if (!error || error.code !== 'ESRCH') throw error;",
      "  }",
      "}, Number.isFinite(delay) && delay >= 0 ? delay : 750);",
    ].join("\n"),
  ], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      BOT_RESTART_PID: String(pid),
      BOT_RESTART_DELAY_MS: String(delayMs),
    },
  });
  child.unref();
}

/**
 * @param {() => void} [restartScheduler]
 * @returns {Action}
 */
export function createRestartAction(restartScheduler = scheduleRestart) {
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
  action_fn: async function () {
    restartScheduler();
    return {
      result: "Restart signal sent.",
      autoContinue: false,
    };
  },
  });
}

export default createRestartAction();
