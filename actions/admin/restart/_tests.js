import assert from "node:assert/strict";
import { createRestartAction, scheduleRestart } from "./index.js";

/**
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   options: { detached: true, stdio: "ignore", env: NodeJS.ProcessEnv },
 * }} SpawnCall
 */

/** @type {ActionTestFn} */
async function action_is_defined(action_fn) {
  assert.equal(typeof action_fn, "function");
}

/** @type {ActionDbTestFn} */
async function restart_returns_before_stopping_the_process(_action_fn, db) {
  let scheduled = 0;
  const action = createRestartAction(() => {
    scheduled += 1;
  });

  const result = await action.action_fn({
    chatId: "test-chat",
    senderIds: ["test-sender"],
    content: [],
    getIsAdmin: async () => true,
    db,
    sessionDb: db,
    getActions: async () => [],
    log: async () => "",
    send: async () => {},
    reply: async () => {},
    reactToMessage: async () => {},
    select: async () => "",
    confirm: async () => true,
    resolveModel: () => "test-model",
  }, {});

  assert.deepEqual(result, {
    result: "Restart signal sent.",
    autoContinue: false,
  });
  assert.equal(scheduled, 1);
}

/** @type {ActionTestFn} */
async function scheduler_uses_detached_delayed_sigterm() {
  /** @type {SpawnCall[]} */
  const spawnCalls = [];
  let unrefCalled = false;

  scheduleRestart({
    pid: 1234,
    delayMs: 25,
    spawnFn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        unref() {
          unrefCalled = true;
        },
      };
    },
  });

  assert.equal(spawnCalls.length, 1);
  const spawnCall = spawnCalls[0];
  assert.ok(spawnCall, "restart helper was not spawned");
  assert.equal(spawnCall.command, process.execPath);
  assert.equal(spawnCall.options.detached, true);
  assert.equal(spawnCall.options.stdio, "ignore");
  assert.equal(spawnCall.options.env.BOT_RESTART_PID, "1234");
  assert.equal(spawnCall.options.env.BOT_RESTART_DELAY_MS, "25");
  assert.match(spawnCall.args.join("\n"), /SIGTERM/);
  assert.equal(unrefCalled, true);
}

/** @type {(ActionTestFn | ActionDbTestFn)[]} */
export default [
  action_is_defined,
  restart_returns_before_stopping_the_process,
  scheduler_uses_detached_delayed_sigterm,
];
