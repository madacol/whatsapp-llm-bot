import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAppRunner } from "../conversation/app-runner.js";

describe("createAppRunner", () => {
  it("exposes the unified harness contract", async () => {
    const harness = createAppRunner();

    assert.equal(harness.getName?.(), "app");
    assert.equal(typeof harness.getCapabilities, "function");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.equal(typeof harness.listSlashCommands, "function");

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
    assert.deepEqual(harness.listSlashCommands?.(), [
      { name: "clear", description: "Clear the current app session" },
      { name: "resume", description: "Restore a previously cleared app session" },
    ]);

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
