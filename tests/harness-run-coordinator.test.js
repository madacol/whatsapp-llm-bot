import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createHarnessRunCoordinator } from "../harnesses/run-coordinator.js";

/**
 * @param {string} chatId
 * @param {string} text
 * @returns {ChannelInput}
 */
function createTurn(chatId, text) {
  return {
    chatId,
    senderIds: ["user-1"],
    senderName: "User",
    content: [{ type: "text", text }],
    timestamp: new Date("2026-03-23T20:00:00.000Z"),
    facts: {
      isGroup: false,
      addressedToBot: false,
      repliedToBot: false,
    },
    io: {
      send: async () => undefined,
      reply: async () => undefined,
      select: async () => "",
      confirm: async () => true,
      react: async () => {},
      getIsAdmin: async () => true,
    },
  };
}

/**
 * @template T
 * @returns {{ promise: Promise<T>, resolve: (value: T) => void }}
 */
function createDeferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

/**
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  assert.fail("Timed out waiting for condition");
}

describe("createHarnessRunCoordinator", () => {
  it("buffers messages while a run is pending setup", async () => {
    const coordinator = createHarnessRunCoordinator();
    const started = await coordinator.beginRun({
      turn: createTurn("chat-1", "first"),
      userText: "first",
      liveInputTarget: { supportsLiveInput: false },
    });
    const buffered = await coordinator.beginRun({ turn: createTurn("chat-1", "second"), userText: "second" });

    assert.equal(started.status, "started");
    assert.equal(buffered.status, "buffered");
    assert.deepEqual(coordinator.consumeBufferedTexts("chat-1"), ["second"]);
    assert.equal(coordinator.finishRun("chat-1"), null);
  });

  it("injects into an active adapter query before starting a second run", async () => {
    /** @type {string[]} */
    const injected = [];
    const liveInputTarget = {
      supportsLiveInput: true,
      injectMessage: (chatId, text) => {
        injected.push(`${typeof chatId === "string" ? chatId : chatId.id}:${text}`);
        return true;
      },
    };

    const coordinator = createHarnessRunCoordinator();
    const started = await coordinator.beginRun({
      turn: createTurn("chat-2", "first"),
      userText: "first",
      liveInputTarget,
    });
    coordinator.markRunActive("chat-2");
    const injectedResult = await coordinator.beginRun({ turn: createTurn("chat-2", "follow-up"), userText: "follow-up" });

    assert.equal(started.status, "started");
    assert.equal(injectedResult.status, "injected");
    assert.deepEqual(injected, ["chat-2:follow-up"]);
    assert.equal(coordinator.finishRun("chat-2"), null);
  });

  it("keeps live input durable until the active sidecar acks injection", async () => {
    const sidecarAck = createDeferred();
    /** @type {string[]} */
    const events = [];
    const liveInputTarget = {
      supportsLiveInput: true,
      injectMessage: async (_chatId, text) => {
        events.push(`inject:${text}`);
        await sidecarAck.promise;
        events.push(`ack:${text}`);
        return true;
      },
    };
    const liveInputJournal = {
      enqueue: async ({ chatId, turnId, text }) => {
        events.push(`enqueue:${chatId}:${turnId}:${text}`);
        return { id: 41 };
      },
      markAccepted: async (id) => {
        events.push(`accepted:${id}`);
      },
    };

    const coordinator = createHarnessRunCoordinator({ liveInputJournal });
    await coordinator.beginRun({
      turn: createTurn("chat-ack", "first"),
      userText: "first",
      liveInputTarget,
    });
    coordinator.markRunActive("chat-ack");
    const followUpTurn = createTurn("chat-ack", "follow-up");
    const injected = coordinator.beginRun({ turn: followUpTurn, userText: "follow-up" });

    await waitUntil(() => events.includes("inject:follow-up"));
    assert.deepEqual(events, [
      "enqueue:chat-ack:chat-ack:follow-up",
      "inject:follow-up",
    ]);

    sidecarAck.resolve(undefined);
    assert.deepEqual(await injected, { status: "injected" });
    assert.deepEqual(events, [
      "enqueue:chat-ack:chat-ack:follow-up",
      "inject:follow-up",
      "ack:follow-up",
      "accepted:41",
    ]);
  });

  it("injects active follow-up text into the original adapter target when the selected owner changes mid-run", async () => {
    /** @type {string[]} */
    const firstInjected = [];
    /** @type {string[]} */
    const secondInjected = [];
    const firstTarget = {
      supportsLiveInput: true,
      injectMessage: (_chatId, text) => {
        firstInjected.push(text);
        return true;
      },
    };
    const secondTarget = {
      supportsLiveInput: true,
      injectMessage: (_chatId, text) => {
        secondInjected.push(text);
        return true;
      },
    };

    const coordinator = createHarnessRunCoordinator();
    const started = await coordinator.beginRun({
      turn: createTurn("chat-owner", "first"),
      userText: "first",
      liveInputTarget: firstTarget,
      ownerKey: "codex:work:model-a",
    });
    coordinator.markRunActive("chat-owner");
    const injectedResult = await coordinator.beginRun({
      turn: createTurn("chat-owner", "follow-up"),
      userText: "follow-up",
      liveInputTarget: secondTarget,
      ownerKey: "cursor:personal:model-b",
    });

    assert.equal(started.status, "started");
    assert.equal(injectedResult.status, "injected");
    assert.deepEqual(firstInjected, ["follow-up"]);
    assert.deepEqual(secondInjected, []);
    assert.equal(coordinator.finishRun("chat-owner"), null);
  });

  it("retries active live input without starting a fallback turn when retry succeeds", async () => {
    /** @type {string[]} */
    const injected = [];
    let ready = false;
    const liveInputTarget = {
      supportsLiveInput: true,
      injectMessage: async (_chatId, text) => {
        if (!ready) {
          return false;
        }
        injected.push(text);
        return true;
      },
    };

    const coordinator = createHarnessRunCoordinator({ liveInputRetryDelayMs: 1 });
    const started = await coordinator.beginRun({
      turn: createTurn("chat-4", "first"),
      userText: "first",
      liveInputTarget,
    });
    coordinator.markRunActive("chat-4");
    const followUp = await coordinator.beginRun({ turn: createTurn("chat-4", "follow-up"), userText: "follow-up" });
    ready = true;
    await delay(10);

    assert.equal(started.status, "started");
    assert.equal(followUp.status, "buffered");
    assert.deepEqual(injected, ["follow-up"]);
    assert.equal(coordinator.finishRun("chat-4"), null);
  });

  it("reuses one durable live-input row across retries until sidecar ack", async () => {
    /** @type {string[]} */
    const events = [];
    let ready = false;
    const liveInputTarget = {
      supportsLiveInput: true,
      injectMessage: async (_chatId, text) => {
        events.push(`inject:${text}`);
        if (!ready) {
          return false;
        }
        return true;
      },
    };
    const liveInputJournal = {
      enqueue: async ({ text }) => {
        events.push(`enqueue:${text}`);
        return { id: 9 };
      },
      markAccepted: async (id) => {
        events.push(`accepted:${id}`);
      },
    };

    const coordinator = createHarnessRunCoordinator({ liveInputRetryDelayMs: 1, liveInputJournal });
    await coordinator.beginRun({
      turn: createTurn("chat-retry-durable", "first"),
      userText: "first",
      liveInputTarget,
    });
    coordinator.markRunActive("chat-retry-durable");
    const followUp = await coordinator.beginRun({
      turn: createTurn("chat-retry-durable", "follow-up"),
      userText: "follow-up",
    });
    ready = true;
    await waitUntil(() => events.includes("accepted:9"));

    assert.equal(followUp.status, "buffered");
    assert.deepEqual(events, [
      "enqueue:follow-up",
      "inject:follow-up",
      "inject:follow-up",
      "accepted:9",
    ]);
  });

  it("returns a fallback turn when live input loses the race with turn completion", async () => {
    const liveInputTarget = {
      supportsLiveInput: true,
      injectMessage: async () => false,
    };

    const coordinator = createHarnessRunCoordinator({ liveInputRetryDelayMs: 50 });
    const started = await coordinator.beginRun({
      turn: createTurn("chat-race", "first"),
      userText: "first",
      liveInputTarget,
    });
    coordinator.markRunActive("chat-race");
    const followUp = await coordinator.beginRun({
      turn: createTurn("chat-race", "s"),
      userText: "s",
    });

    const nextTurn = coordinator.finishRun("chat-race");

    assert.equal(started.status, "started");
    assert.equal(followUp.status, "buffered");
    assert.equal(nextTurn?.content[0]?.type, "text");
    assert.equal(nextTurn?.content[0]?.type === "text" ? nextTurn.content[0].text : "", "s");
    assert.equal(coordinator.finishRun("chat-race"), null);
  });

  it("prepares the latest failed live-input turn for replay on finish", async () => {
    const liveInputTarget = {
      supportsLiveInput: true,
      injectMessage: async () => false,
    };

    const coordinator = createHarnessRunCoordinator({ liveInputRetryDelayMs: 50 });
    await coordinator.beginRun({
      turn: createTurn("chat-release", "first"),
      userText: "first",
      liveInputTarget,
    });
    coordinator.markRunActive("chat-release");
    const firstFollowUp = createTurn("chat-release", "ready");
    const latestFollowUp = createTurn("chat-release", "what's the command?");

    await coordinator.beginRun({ turn: firstFollowUp, userText: "ready" });
    await coordinator.beginRun({ turn: latestFollowUp, userText: "what's the command?" });

    const replay = coordinator.preparePendingLiveInputReplay("chat-release", firstFollowUp);
    assert.equal(replay?.turn, latestFollowUp);
    assert.equal(replay?.text, "what's the command?");
    const nextTurn = coordinator.finishRun("chat-release");
    assert.equal(nextTurn?.content[0]?.type, "text");
    assert.equal(nextTurn?.content[0]?.type === "text" ? nextTurn.content[0].text : "", "what's the command?");
    assert.equal(coordinator.finishRun("chat-release"), null);
  });

  it("returns the latest buffered turn after a non-live run finishes", async () => {
    const coordinator = createHarnessRunCoordinator();
    await coordinator.beginRun({
      turn: createTurn("chat-3", "first"),
      userText: "first",
      liveInputTarget: { supportsLiveInput: false },
    });
    coordinator.markRunActive("chat-3");
    const buffered = await coordinator.beginRun({ turn: createTurn("chat-3", "second"), userText: "second" });

    assert.equal(buffered.status, "buffered");
    assert.equal(coordinator.consumeBufferedTexts("chat-3").length, 0);
    assert.equal(coordinator.finishRun("chat-3")?.content[0]?.type, "text");
    if (coordinator.finishRun("chat-3") !== null) {
      assert.fail("Expected buffered turn queue to be drained after finishRun");
    }
  });
});
