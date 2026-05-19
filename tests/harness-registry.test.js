import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHarnessAdapterFromHarness,
  getHarnessSessionDirectory,
  getHarnessDriverStatus,
  listHarnessInstances,
  listHarnessDrivers,
  registerHarnessDriver,
  registerOptionalHarnesses,
  resetHarnessRegistryForTests,
  resolveHarness,
  resolveHarnessInstance,
  reconcileHarnessInstances,
} from "../harnesses/index.js";

afterEach(async () => {
  resetHarnessRegistryForTests();
  await registerOptionalHarnesses();
});

/**
 * @param {string} name
 * @param {Partial<AgentHarness>} [overrides]
 * @returns {AgentHarness}
 */
function createTestHarness(name, overrides = {}) {
  return {
    getName: () => name,
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
    ...overrides,
  };
}

describe("harness driver registry", () => {
  it("lists default driver metadata separately from harness instances", () => {
    const drivers = listHarnessDrivers();
    const defaultDrivers = drivers
      .filter((driver) => ["codex", "pi"].includes(driver.name))
      .map((driver) => ({
        name: driver.name,
        displayName: driver.displayName,
        supportsInstances: driver.supportsInstances,
      }));

    assert.deepEqual(
      defaultDrivers,
      [
        { name: "codex", displayName: "Codex", supportsInstances: true },
        { name: "pi", displayName: "Pi", supportsInstances: true },
      ],
    );
  });

  it("reads provider status through the driver seam", async () => {
    registerHarnessDriver({
      name: "status-test",
      displayName: "Status Test",
      supportsInstances: true,
      createInstance() {
        return {
          harness: createTestHarness("status-test"),
        };
      },
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
  it("registers drivers as value objects that materialize instance bundles", async () => {
    registerHarnessDriver({
      name: "bundle-test",
      displayName: "Bundle Test",
      supportsInstances: true,
      createInstance(input) {
        return {
          status: { availability: "available", checkedAt: "2026-05-19T00:00:00.000Z" },
          harness: createTestHarness(input.name),
          textGeneration: {
            generateSessionTitle: async () => ({ title: `title:${input.instanceId}` }),
          },
        };
      },
    });

    const instance = resolveHarnessInstance("bundle-test", { instanceId: "work" });
    const harness = resolveHarness("bundle-test", { instanceId: "work" });

    assert.equal(instance.name, "bundle-test");
    assert.equal(instance.instanceId, "work");
    assert.equal(instance.status.availability, "available");
    assert.equal(harness.getName(), "bundle-test");
    assert.equal(typeof harness.getCapabilities, "function");
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.handleCommand, "function");
    assert.equal(typeof harness.listSlashCommands, "function");
    assert.deepEqual(harness.listSlashCommands(), []);
    assert.equal(await instance.textGeneration?.generateSessionTitle?.({
      transcript: "User: hello",
      messages: [],
      chatInfo: undefined,
    }), "title:work");
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
    registerHarnessDriver({
      name: "instance-test",
      displayName: "Instance Test",
      supportsInstances: true,
      createInstance(input) {
        created.push(input.instanceId);
        return {
          harness: createTestHarness("instance-test", {
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
          }),
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

  it("rebuilds only changed harness instances during reconciliation", async () => {
    /** @type {string[]} */
    const created = [];
    /** @type {string[]} */
    const disposed = [];
    registerHarnessDriver({
      name: "reconcile-test",
      displayName: "Reconcile Test",
      supportsInstances: true,
      createInstance(input) {
        const marker = typeof input.config.marker === "string" ? input.config.marker : "none";
        created.push(`${input.instanceId}:${marker}`);
        return {
          harness: createTestHarness("reconcile-test"),
          dispose: async () => {
            disposed.push(`${input.instanceId}:${marker}`);
          },
        };
      },
    });

    resolveHarnessInstance("reconcile-test", { instanceId: "work", config: { marker: "a" } });
    resolveHarnessInstance("reconcile-test", { instanceId: "personal", config: { marker: "x" } });

    await reconcileHarnessInstances([
      {
        name: "reconcile-test",
        instanceId: "work",
        config: { marker: "b" },
      },
      {
        name: "reconcile-test",
        instanceId: "personal",
        config: { marker: "x" },
      },
    ]);

    const work = resolveHarnessInstance("reconcile-test", { instanceId: "work", config: { marker: "b" } });
    const personal = resolveHarnessInstance("reconcile-test", { instanceId: "personal", config: { marker: "x" } });

    assert.equal(work.instanceId, "work");
    assert.equal(personal.instanceId, "personal");
    assert.deepEqual(created, ["work:a", "personal:x", "work:b"]);
    assert.deepEqual(disposed, ["work:a"]);
  });

  it("surfaces unknown harness instance envelopes as unavailable without constructing native fallback", () => {
    const instance = resolveHarnessInstance("missing-driver", {
      instanceId: "from-config",
      config: { model: "ignored" },
      displayName: "Missing Driver",
    });

    assert.equal(instance.name, "missing-driver");
    assert.equal(instance.instanceId, "from-config");
    assert.equal(instance.displayName, "Missing Driver");
    assert.equal(instance.available, false);
    assert.equal(instance.status.availability, "unavailable");
    assert.match(instance.status.message ?? "", /not registered/);
    assert.deepEqual(instance.capabilities, {
      supportsResume: false,
      supportsCancel: false,
      supportsLiveInput: false,
      supportsApprovals: false,
      supportsWorkdir: false,
      supportsSandboxConfig: false,
      supportsModelSelection: false,
      supportsReasoningEffort: false,
      supportsSessionFork: false,
      sessionModelSwitch: "in-session",
      supportsRollback: false,
      supportsUserInputRequests: false,
    });
  });

  it("routes non-instanced drivers to the default instance", () => {
    let createCount = 0;
    registerHarnessDriver({
      name: "single-test",
      supportsInstances: false,
      createInstance() {
        createCount += 1;
        return { harness: createTestHarness("single-test") };
      },
    });

    const first = resolveHarnessInstance("single-test", { instanceId: "ignored" });
    const second = resolveHarnessInstance("single-test", { instanceId: "other" });

    assert.equal(first.instanceId, "single-test");
    assert.equal(second.instanceId, "single-test");
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

  it("accepts semantic turn input through the adapter compatibility bridge", async () => {
    /** @type {AgentHarness} */
    const harness = {
      getName: () => "semantic-adapter-test",
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
      async run(params) {
        assert.equal(params.session.chatId, "semantic-chat");
        assert.deepEqual(params.messages, [
          { role: "user", content: [{ type: "text", text: "semantic input" }] },
        ]);
        return {
          response: [{ type: "text", text: "ok" }],
          messages: params.messages,
          usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
        };
      },
      handleCommand: async () => false,
      listSlashCommands: () => [],
    };
    const adapter = createHarnessAdapterFromHarness({
      harness,
      name: "semantic-adapter-test",
      instanceId: "default",
      continuationKey: "semantic-adapter-test:instance:default",
    });

    const result = await adapter.sendTurn({
      chatId: "semantic-chat",
      input: "semantic input",
      runConfig: { model: "model-a" },
    });

    assert.deepEqual(result.response, [{ type: "text", text: "ok" }]);
  });

  it("exposes a provider-instance text generation hook", async () => {
    registerHarnessDriver({
      name: "text-generation-test",
      supportsInstances: true,
      createInstance() {
        return {
          harness: createTestHarness("text-generation-test"),
          textGeneration: {
            generateSessionTitle: async () => ({ title: "Provider Title" }),
          },
        };
      },
    });

    const instance = resolveHarnessInstance("text-generation-test", { instanceId: "work" });

    assert.equal(await instance.textGeneration?.generateSessionTitle?.({
      transcript: "User: hello",
      messages: [],
      chatInfo: undefined,
    }), "Provider Title");
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
