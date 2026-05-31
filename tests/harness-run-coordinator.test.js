import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createHarnessRunCoordinator } from "../harnesses/run-coordinator.js";

/**
 * @param {string} chatId
 * @param {string} text
 * @returns {ChatTurn}
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
