import assert from "node:assert/strict";
import { createRestartAction, scheduleRestart } from "./index.js";

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
async function scheduler_uses_delayed_sigterm() {
  /** @type {{ pid: number, signal: NodeJS.Signals }[]} */
  const killCalls = [];
  let scheduledDelay = null;
  let unrefCalled = false;

  scheduleRestart({
    pid: 1234,
    delayMs: 25,
    killFn(pid, signal) {
      killCalls.push({ pid, signal });
    },
    setTimeoutFn(callback, delayMs) {
      scheduledDelay = delayMs;
      callback();
      return {
        unref() {
          unrefCalled = true;
        },
      };
    },
  });

  assert.equal(scheduledDelay, 25);
  assert.deepEqual(killCalls, [{ pid: 1234, signal: "SIGTERM" }]);
  assert.equal(unrefCalled, true);
}

/** @type {(ActionTestFn | ActionDbTestFn)[]} */
export default [
  action_is_defined,
  restart_returns_before_stopping_the_process,
  scheduler_uses_delayed_sigterm,
];
