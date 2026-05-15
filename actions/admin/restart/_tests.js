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

  if (typeof result !== "object" || result === null || Array.isArray(result) || !("result" in result)) {
    throw new Error("Expected restart action to return an ActionResult object");
  }
  assert.equal(result.result, "Restart signal sent.");
  assert.equal(result.autoContinue, false);
  assert.equal(typeof result.afterResponse, "function");
  assert.equal(scheduled, 0);

  await result.afterResponse?.();
  assert.equal(scheduled, 1);
}

/** @type {ActionDbTestFn} */
async function restart_waits_for_queued_ack_before_stopping(_action_fn, db) {
  let scheduled = 0;
  let releaseAck = () => {};
  const ackSent = new Promise((resolve) => {
    releaseAck = () => {
      resolve(undefined);
    };
  });
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

  if (typeof result !== "object" || result === null || Array.isArray(result) || !("afterResponse" in result)) {
    throw new Error("Expected restart action to return an afterResponse hook");
  }

  const afterResponse = result.afterResponse?.({
    handle: {
      keyId: undefined,
      isImage: false,
      deliveryStatus: "queued",
      waitUntilSent: async () => {
        await ackSent;
        return undefined;
      },
      update: async () => {},
      setInspect: () => {},
    },
  });

  await Promise.resolve();
  assert.equal(scheduled, 0);
  releaseAck();
  await afterResponse;
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
  restart_waits_for_queued_ack_before_stopping,
  scheduler_uses_delayed_sigterm,
];
