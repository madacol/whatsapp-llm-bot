import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registerHarness,
  registerOptionalHarnesses,
  resetHarnessRegistryForTests,
  resolveHarness,
} from "../harnesses/index.js";

afterEach(async () => {
  resetHarnessRegistryForTests();
  await registerOptionalHarnesses();
});

describe("resolveHarness", () => {
  it("normalizes legacy harness factories to the unified contract", async () => {
    registerHarness("legacy-test", () => ({
      /**
       * @param {AgentHarnessParams} _params
       * @returns {Promise<AgentResult>}
       */
      async processLlmResponse(_params) {
        return {
          response: [],
          messages: [],
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        };
      },
    }));

    const harness = resolveHarness("legacy-test");

    assert.equal(harness.getName(), "legacy-test");
    assert.equal(typeof harness.getCapabilities, "function");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.equal(typeof harness.listSlashCommands, "function");
    assert.deepEqual(harness.listSlashCommands(), []);
    assert.equal(await harness.handleCommand({
      chatId: "chat-1",
      command: "noop",
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "chat-1",
        senderIds: [],
        content: [],
        getIsAdmin: async () => true,
        send: async () => undefined,
        reply: async () => undefined,
        reactToMessage: async () => {},
        select: async () => "",
        confirm: async () => true,
      }),
    }), false);
  });
});
