import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNativeHarness } from "../harnesses/native.js";

describe("createNativeHarness", () => {
  it("exposes the unified harness contract", async () => {
    const harness = createNativeHarness();

    assert.equal(harness.getName?.(), "native");
    assert.equal(typeof harness.getCapabilities, "function");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");

    const capabilities = harness.getCapabilities?.();
    assert.deepEqual(capabilities, {
      supportsResume: false,
      supportsCancel: false,
      supportsLiveInput: false,
      supportsApprovals: true,
      supportsWorkdir: true,
      supportsSandboxConfig: false,
      supportsModelSelection: false,
      supportsReasoningEffort: false,
      supportsSessionFork: false,
    });

    const handled = await harness.handleCommand?.({
      chatId: "chat-1",
      command: "model off",
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
    });

    assert.equal(handled, false);
  });
});
