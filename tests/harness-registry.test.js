import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHarnessAdapterFromHarness,
  getHarnessSessionDirectory,
  getHarnessDriverStatus,
  listHarnessInstances,
  listHarnessDrivers,
  registerHarness,
  registerHarnessDriver,
  registerOptionalHarnesses,
  resetHarnessRegistryForTests,
  resolveHarness,
  resolveHarnessInstance,
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

  it("materializes isolated harness instances from one driver", async () => {
    /** @type {string[]} */
    const created = [];
    registerHarnessDriver("instance-test", () => {
      assert.fail("Instance-aware test driver should use createInstance.");
    }, {
      displayName: "Instance Test",
      supportsInstances: true,
      createInstance(input) {
        created.push(input.instanceId);
        return {
          getName: () => "instance-test",
          getCapabilities: () => ({
            supportsResume: true,
            supportsCancel: true,
            supportsLiveInput: false,
            supportsApprovals: false,
            supportsWorkdir: true,
            supportsSandboxConfig: false,
            supportsModelSelection: true,
            supportsReasoningEffort: false,
            supportsSessionFork: false,
            sessionModelSwitch: "unsupported",
            supportsRollback: true,
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
        };
      },
    });

    const first = resolveHarnessInstance("instance-test", { instanceId: "work" });
    const second = resolveHarnessInstance("instance-test", { instanceId: "personal" });
    const firstAgain = resolveHarnessInstance("instance-test", { instanceId: "work" });

    assert.equal(first.instanceId, "work");
    assert.equal(second.instanceId, "personal");
    assert.notEqual(first.harness, second.harness);
    assert.equal(first.harness, firstAgain.harness);
    assert.deepEqual(created, ["work", "personal"]);
    assert.deepEqual(
      listHarnessInstances().filter((instance) => instance.name === "instance-test"),
      [
        {
          name: "instance-test",
          instanceId: "work",
          displayName: "Instance Test",
          supportsInstances: true,
          continuationKey: "instance-test:instance:work",
          capabilities: first.capabilities,
        },
        {
          name: "instance-test",
          instanceId: "personal",
          displayName: "Instance Test",
          supportsInstances: true,
          continuationKey: "instance-test:instance:personal",
          capabilities: second.capabilities,
        },
      ],
    );
  });

  it("routes non-instanced drivers to the default instance", () => {
    let createCount = 0;
    registerHarnessDriver("single-test", () => {
      createCount += 1;
      return {
        getName: () => "single-test",
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
      };
    }, { supportsInstances: false });

    const first = resolveHarnessInstance("single-test", { instanceId: "ignored" });
    const second = resolveHarnessInstance("single-test", { instanceId: "other" });

    assert.equal(first.instanceId, "default");
    assert.equal(second.instanceId, "default");
    assert.equal(first.harness, second.harness);
    assert.equal(createCount, 1);
  });

  it("exposes an adapter facade for legacy harnesses", async () => {
    /** @type {AgentHarness} */
    const harness = {
      getName: () => "adapter-test",
      getCapabilities: () => ({
        supportsResume: true,
        supportsCancel: true,
        supportsLiveInput: true,
        supportsApprovals: false,
        supportsWorkdir: true,
        supportsSandboxConfig: false,
        supportsModelSelection: true,
        supportsReasoningEffort: false,
        supportsSessionFork: false,
      }),
      async run(params) {
        return {
          response: [{ type: "text", text: params.messages.length.toString() }],
          messages: params.messages,
          usage: { promptTokens: 1, completionTokens: 2, cachedTokens: 0, cost: 0 },
        };
      },
      handleCommand: async () => false,
      listSlashCommands: () => [],
      injectMessage: async (_chatId, text) => text === "yes",
      cancel: () => true,
    };
    const adapter = createHarnessAdapterFromHarness({
      harness,
      name: "adapter-test",
      instanceId: "work",
      continuationKey: "adapter-test:instance:work",
    });

    const session = await adapter.startSession({
      chatId: "chat-1",
      runConfig: { workdir: "/repo", model: "model-a" },
    });
    assert.deepEqual(session, {
      chatId: "chat-1",
      harnessName: "adapter-test",
      instanceId: "work",
      continuationKey: "adapter-test:instance:work",
      status: "ready",
      workdir: "/repo",
      model: "model-a",
    });
    assert.equal(await adapter.injectMessage("chat-1", "yes"), true);
    assert.equal(await adapter.interruptTurn({ chatId: "chat-1" }), true);
  });
});

describe("harness session directory", () => {
  it("stores routable session bindings by chat", () => {
    const directory = getHarnessSessionDirectory();
    directory.clear();

    directory.upsert({
      chatId: "chat-1",
      harnessName: "codex",
      instanceId: "work",
      status: "running",
      resumeCursor: "thread-1",
      runtimeMode: "workspace-write",
      runtimePayload: { model: "gpt-5.4", workdir: "/repo" },
    });

    assert.deepEqual(directory.getBinding("chat-1"), {
      chatId: "chat-1",
      harnessName: "codex",
      instanceId: "work",
      status: "running",
      resumeCursor: "thread-1",
      runtimeMode: "workspace-write",
      runtimePayload: { model: "gpt-5.4", workdir: "/repo" },
      updatedAt: directory.getBinding("chat-1")?.updatedAt,
    });
    assert.equal(directory.getHarness("chat-1"), "codex");
    assert.equal(directory.resolveRoutableSession("chat-1")?.instanceId, "work");
  });
});
