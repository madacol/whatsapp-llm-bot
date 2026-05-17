import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getHarnessDriverStatus,
  listHarnessDrivers,
  registerHarness,
  registerHarnessDriver,
  registerOptionalHarnesses,
  resetHarnessRegistryForTests,
  resolveHarness,
} from "../harnesses/index.js";

afterEach(async () => {
  resetHarnessRegistryForTests();
  await registerOptionalHarnesses();
});

describe("harness driver registry", () => {
  it("lists default driver metadata separately from harness instances", () => {
    const drivers = listHarnessDrivers();
    const defaultDrivers = drivers
      .filter((driver) => ["native", "codex", "pi"].includes(driver.name))
      .map((driver) => ({
        name: driver.name,
        displayName: driver.displayName,
        supportsInstances: driver.supportsInstances,
      }));

    assert.deepEqual(
      defaultDrivers,
      [
        { name: "native", displayName: "Native Tools", supportsInstances: false },
        { name: "codex", displayName: "Codex", supportsInstances: true },
        { name: "pi", displayName: "Pi", supportsInstances: true },
      ],
    );
  });

  it("reads provider status through the driver seam", async () => {
    registerHarnessDriver("status-test", () => ({
      getName: () => "status-test",
      getCapabilities: () => ({
        supportsResume: false,
        supportsCancel: false,
        supportsLiveInput: false,
        supportsApprovals: false,
        supportsWorkdir: false,
        supportsSandboxConfig: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsSessionFork: false,
      }),
      async run() {
        return {
          response: [],
          messages: [],
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        };
      },
      handleCommand: async () => false,
      listSlashCommands: () => [],
    }), {
      displayName: "Status Test",
      supportsInstances: true,
      async getStatus() {
        return {
          availability: "maintenance",
          message: "scheduled provider maintenance",
          checkedAt: "2026-05-17T00:00:00.000Z",
        };
      },
    });

    assert.deepEqual(await getHarnessDriverStatus("status-test"), {
      name: "status-test",
      displayName: "Status Test",
      supportsInstances: true,
      availability: "maintenance",
      message: "scheduled provider maintenance",
      checkedAt: "2026-05-17T00:00:00.000Z",
    });
  });
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
