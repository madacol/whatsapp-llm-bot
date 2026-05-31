import assert from "node:assert/strict";
import { createRestartAction, scheduleRestart } from "./index.js";

/**
 * @param {import("../../../restart/restart-ack-store.js").RestartAckRecord[]} [savedRecords]
 * @returns {import("../../../restart/restart-ack-store.js").RestartAckStore}
 */
function createMemoryRestartAckStore(savedRecords = []) {
  return {
    save: async (record) => {
      savedRecords.push(record);
    },
    read: async () => savedRecords.at(-1) ?? null,
    clear: async () => {},
  };
}

/**
 * @param {ChatDb} db
 * @returns {ActionContext}
 */
function createActionContext(db) {
  return {
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
  };
}

/** @type {ActionTestFn} */
async function action_is_defined(action_fn) {
  assert.equal(typeof action_fn, "function");
}

/** @type {ActionDbTestFn} */
async function restart_returns_before_stopping_the_process(_action_fn, db) {
  let scheduled = 0;
  const action = createRestartAction(
    () => {
      scheduled += 1;
    },
    createMemoryRestartAckStore(),
  );

  const result = await action.action_fn(createActionContext(db), {});

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
  const action = createRestartAction(
    () => {
      scheduled += 1;
    },
    createMemoryRestartAckStore(),
  );

  const result = await action.action_fn(createActionContext(db), {});

  if (typeof result !== "object" || result === null || Array.isArray(result) || !("afterResponse" in result)) {
    throw new Error("Expected restart action to return an afterResponse hook");
  }

  const afterResponse = result.afterResponse?.({
    handle: {
      deliveryStatus: "queued",
      queueId: 42,
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

/** @type {ActionDbTestFn} */
async function restart_persists_queue_id_for_unsent_ack_before_stopping(_action_fn, db) {
  /** @type {import("../../../restart/restart-ack-store.js").RestartAckRecord[]} */
  const savedRecords = [];
  let scheduled = 0;
  const action = createRestartAction(
    () => {
      scheduled += 1;
    },
    createMemoryRestartAckStore(savedRecords),
  );

  const result = await action.action_fn({ ...createActionContext(db), chatId: "restart-queued-chat" }, {});

  if (typeof result !== "object" || result === null || Array.isArray(result) || !("afterResponse" in result)) {
    throw new Error("Expected restart action to return an afterResponse hook");
  }

  await result.afterResponse?.({
    handle: {
      deliveryStatus: "queued",
      queueId: 77,
      waitUntilSent: async () => undefined,
      update: async () => {},
      setInspect: () => {},
    },
  });

  assert.equal(scheduled, 1);
  assert.equal(savedRecords.length, 1);
  assert.equal(savedRecords[0].chatId, "restart-queued-chat");
  assert.equal(savedRecords[0].queueId, 77);
  assert.equal(savedRecords[0].transportHandleId, undefined);
}

/** @type {ActionDbTestFn} */
async function restart_persists_sent_ack_transport_handle_before_stopping(_action_fn, db) {
  /** @type {import("../../../restart/restart-ack-store.js").RestartAckRecord[]} */
  const savedRecords = [];
  let scheduled = 0;
  const action = createRestartAction(
    () => {
      scheduled += 1;
    },
    createMemoryRestartAckStore(savedRecords),
  );

  const result = await action.action_fn({ ...createActionContext(db), chatId: "restart-chat" }, {});

  if (typeof result !== "object" || result === null || Array.isArray(result) || !("afterResponse" in result)) {
    throw new Error("Expected restart action to return an afterResponse hook");
  }

  await result.afterResponse?.({
    handle: {
      transportHandleId: "ack-transport-handle",
      deliveryStatus: "sent",
      waitUntilSent: async function () {
        return this;
      },
      update: async () => {},
      setInspect: () => {},
    },
  });

  assert.equal(scheduled, 1);
  assert.equal(savedRecords.length, 2);
  assert.deepEqual(savedRecords[0].chatId, "restart-chat");
  assert.equal(savedRecords[0].transportHandleId, undefined);
  assert.deepEqual(savedRecords[1].chatId, "restart-chat");
  assert.equal(savedRecords[1].transportHandleId, "ack-transport-handle");
}

/** @type {ActionDbTestFn} */
async function restart_waits_for_active_turns_before_scheduling(_action_fn, db) {
  let scheduled = 0;
  let waited = false;
  /** @type {string[]} */
  const updates = [];
  const action = createRestartAction(
    () => {
      scheduled += 1;
    },
    createMemoryRestartAckStore(),
    {
      listActiveTurns: () => [{ chatId: "active-chat", label: "codex" }],
      waitForIdle: async () => {
        assert.equal(scheduled, 0);
        waited = true;
        return [{ chatId: "active-chat", label: "codex" }];
      },
    },
  );

  const result = await action.action_fn(createActionContext(db), {});
  if (typeof result !== "object" || result === null || Array.isArray(result) || !("afterResponse" in result)) {
    throw new Error("Expected restart action to return an afterResponse hook");
  }

  await result.afterResponse?.({
    handle: {
      transportHandleId: "active-turn-ack-handle",
      deliveryStatus: "sent",
      waitUntilSent: async function () {
        return this;
      },
      update: async (update) => {
        if (update.kind === "text") {
          updates.push(update.text);
        }
      },
      setInspect: () => {},
    },
  });

  assert.equal(waited, true);
  assert.equal(scheduled, 1);
  assert.deepEqual(updates, ["Restart queued; waiting for 1 active turn to finish."]);
}

/** @type {ActionDbTestFn} */
async function restart_force_records_active_turns_without_waiting(_action_fn, db) {
  /** @type {import("../../../restart/restart-ack-store.js").RestartAckRecord[]} */
  const savedRecords = [];
  let scheduled = 0;
  const action = createRestartAction(
    () => {
      scheduled += 1;
    },
    createMemoryRestartAckStore(savedRecords),
    {
      listActiveTurns: () => [{ chatId: "active-chat", label: "codex" }],
      waitForIdle: async () => {
        throw new Error("Forced restart should not wait for active turns");
      },
    },
  );

  const result = await action.action_fn(createActionContext(db), { mode: "--force" });
  if (typeof result !== "object" || result === null || Array.isArray(result) || !("afterResponse" in result)) {
    throw new Error("Expected restart action to return an afterResponse hook");
  }

  await result.afterResponse?.();

  assert.equal(scheduled, 1);
  assert.deepEqual(savedRecords.at(-1)?.interruptedTurns, [{
    chatId: "active-chat",
    label: "codex",
  }]);
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
  restart_persists_queue_id_for_unsent_ack_before_stopping,
  restart_persists_sent_ack_transport_handle_before_stopping,
  restart_waits_for_active_turns_before_scheduling,
  restart_force_records_active_turns_without_waiting,
  scheduler_uses_delayed_sigterm,
];
