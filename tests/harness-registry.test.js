import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getHarnessSessionDirectory,
  getHarnessDriverStatus,
  listHarnessInstances,
  listHarnessDrivers,
  registerAcpAgentDriver,
  registerHarnessDriver,
  registerOptionalHarnesses,
  resetHarnessRegistryForTests,
  resolveHarness,
  resolveHarnessName,
  resolveHarnessInstance,
  reconcileHarnessInstances,
} from "../harnesses/index.js";
import config from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

afterEach(async () => {
  delete process.env.DEFAULT_HARNESS;
  delete process.env.MADABOT_DEFAULT_HARNESS;
  resetHarnessRegistryForTests();
  await registerOptionalHarnesses();
});

/**
 * @param {string} name
 * @param {string} instanceId
 * @param {string} continuationKey
 * @returns {HarnessAdapter}
 */
function createTestAdapter(name, instanceId, continuationKey) {
  /** @type {Map<string, HarnessRuntimeSession>} */
  const sessions = new Map();
  return {
    async startSession(input) {
      const session = {
        chatId: input.chatId,
        harnessName: name,
        instanceId,
        continuationKey,
        status: "ready",
        workdir: input.runConfig?.workdir ?? null,
        model: input.runConfig?.model ?? null,
        resumeCursor: input.resumeCursor ?? null,
      };
      sessions.set(input.chatId, /** @type {HarnessRuntimeSession} */ (session));
      return /** @type {HarnessRuntimeSession} */ (session);
    },
    async sendTurn(input) {
      return {
        response: [],
        messages: input.messages ?? [],
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    },
    interruptTurn: async () => false,
    respondToRequest: async () => false,
    respondToUserInput: async () => false,
    injectMessage: async () => false,
    stopSession: async (chatId) => {
      sessions.delete(typeof chatId === "string" ? chatId : chatId.id);
      return true;
    },
    hasSession: (chatId) => sessions.has(typeof chatId === "string" ? chatId : chatId.id),
    stopAll: async () => {
      sessions.clear();
    },
    listSessions: () => [...sessions.values()],
    readThread: async () => null,
    rollbackThread: async () => null,
    streamEvents: {
      async *[Symbol.asyncIterator]() {},
    },
  };
}

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
    createAdapter: ({ name: adapterName, instanceId, continuationKey }) => createTestAdapter(adapterName, instanceId, continuationKey),
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

  it("runs the production codex driver through ACP", async () => {
    const instance = resolveHarnessInstance("codex", {
      instanceId: "acp-work",
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });

    assert.equal(instance.harness.getName(), "codex");
    assert.equal(instance.capabilities.supportsSessionFork, true);
    assert.equal(instance.capabilities.supportsLiveInput, true);

    /** @type {string[]} */
    const eventTypes = [];
    const unsubscribe = instance.adapter.subscribeEvents?.((event) => {
      eventTypes.push(event.type);
    });
    try {
      await instance.adapter.startSession({ chatId: "codex-acp-chat" });
      const result = await instance.adapter.sendTurn({
        chatId: "codex-acp-chat",
        input: "Run ACP Codex",
        messages: [{ role: "user", content: [{ type: "text", text: "Run ACP Codex" }] }],
      });

      assert.deepEqual(result.response, [{ type: "markdown", text: "Main result." }]);
      assert.equal(instance.adapter.listSessions()[0]?.resumeCursor, "mock-session-1");
      assert.ok(eventTypes.includes("plan.updated"));
      assert.ok(eventTypes.includes("subagent.completed"));
      assert.ok(eventTypes.includes("file-change.completed"));
      assert.ok(eventTypes.includes("usage.updated"));
    } finally {
      unsubscribe?.();
    }
  });

  it("runs the production Claude and Pi drivers through ACP", async () => {
    await registerOptionalHarnesses();

    for (const name of ["claude", "pi"]) {
      const instance = resolveHarnessInstance(name, {
        instanceId: `${name}-acp-work`,
        config: {
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
        },
      });

      assert.equal(instance.harness.getName(), name);
      const result = await instance.adapter.sendTurn({
        chatId: `${name}-chat`,
        input: `Run ${name} through ACP`,
        messages: [{ role: "user", content: [{ type: "text", text: `Run ${name} through ACP` }] }],
      });

      assert.deepEqual(result.response, [{ type: "markdown", text: "Main result." }]);
      assert.equal(instance.adapter.listSessions()[0]?.resumeCursor, "mock-session-1");
    }
  });

  it("registers a new ACP agent from one provider definition", async () => {
    registerAcpAgentDriver({
      name: "cursor",
      displayName: "Cursor",
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      sessionKind: "cursor",
    });

    const instance = resolveHarnessInstance("cursor", { instanceId: "cursor-work" });

    assert.equal(instance.name, "cursor");
    assert.equal(instance.displayName, "Cursor");
    assert.equal(instance.harness.getName(), "cursor");
    assert.equal(instance.capabilities.supportsSessionFork, true);

    const result = await instance.adapter.sendTurn({
      chatId: "cursor-acp-chat",
      input: "Run Cursor ACP",
      messages: [{ role: "user", content: [{ type: "text", text: "Run Cursor ACP" }] }],
    });

    assert.deepEqual(result.response, [{ type: "markdown", text: "Main result." }]);
    assert.equal(instance.adapter.listSessions()[0]?.resumeCursor, "mock-session-1");
    assert.ok(
      instance.harness.listSlashCommands().some((command) => command.description.includes("Cursor")),
      "Expected generic ACP slash commands to use the agent display label",
    );
  });

  it("registers extra ACP agents from MADABOT_ACP_AGENTS_JSON", async () => {
    const previous = process.env.MADABOT_ACP_AGENTS_JSON;
    process.env.MADABOT_ACP_AGENTS_JSON = JSON.stringify([{
      name: "env-agent",
      displayName: "Env Agent",
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      sessionKind: "env-agent",
    }]);
    try {
      resetHarnessRegistryForTests();
      const drivers = listHarnessDrivers();
      assert.ok(drivers.some((driver) => driver.name === "env-agent" && driver.displayName === "Env Agent"));

      const instance = resolveHarnessInstance("env-agent", { instanceId: "env-agent-work" });
      const result = await instance.adapter.sendTurn({
        chatId: "env-agent-chat",
        input: "Run env ACP",
        messages: [{ role: "user", content: [{ type: "text", text: "Run env ACP" }] }],
      });

      assert.deepEqual(result.response, [{ type: "markdown", text: "Main result." }]);
    } finally {
      if (previous === undefined) {
        delete process.env.MADABOT_ACP_AGENTS_JSON;
      } else {
        process.env.MADABOT_ACP_AGENTS_JSON = previous;
      }
      resetHarnessRegistryForTests();
      await registerOptionalHarnesses();
    }
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

  it("awaits stale instance disposal before replacing a changed instance", async () => {
    /** @type {string[]} */
    const calls = [];
    registerHarnessDriver({
      name: "lifecycle-test",
      supportsInstances: true,
      createInstance(input) {
        const marker = typeof input.config.marker === "string" ? input.config.marker : "none";
        calls.push(`create:${marker}`);
        return {
          harness: createTestHarness("lifecycle-test"),
          dispose: async () => {
            calls.push(`dispose:start:${marker}`);
            await Promise.resolve();
            calls.push(`dispose:done:${marker}`);
          },
        };
      },
    });

    resolveHarnessInstance("lifecycle-test", { instanceId: "work", config: { marker: "a" } });
    await reconcileHarnessInstances([
      { name: "lifecycle-test", instanceId: "work", config: { marker: "b" } },
    ]);

    assert.deepEqual(calls, [
      "create:a",
      "dispose:start:a",
      "dispose:done:a",
      "create:b",
    ]);
  });

  it("downgrades invalid harness config into an unavailable instance status", () => {
    registerHarnessDriver({
      name: "schema-test",
      displayName: "Schema Test",
      supportsInstances: true,
      configSchema(config) {
        if (typeof config.command !== "string") {
          throw new Error("command must be a string");
        }
        return config;
      },
      createInstance() {
        return {
          harness: createTestHarness("schema-test"),
        };
      },
    });

    const instance = resolveHarnessInstance("schema-test", {
      instanceId: "work",
      config: { command: 42 },
    });

    assert.equal(instance.available, false);
    assert.equal(instance.status.availability, "unavailable");
    assert.match(instance.status.message ?? "", /Invalid config/);
    assert.match(instance.status.message ?? "", /command must be a string/);
  });

  it("surfaces unknown harness instance envelopes as unavailable without constructing an app fallback", () => {
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

  it("marks drivers without a semantic adapter unavailable", () => {
    registerHarnessDriver({
      name: "legacy-no-adapter",
      supportsInstances: true,
      createInstance: () => ({
        harness: {
          ...createTestHarness("legacy-no-adapter"),
          createAdapter: undefined,
        },
      }),
    });

    const instance = resolveHarnessInstance("legacy-no-adapter", { instanceId: "work" });

    assert.equal(instance.available, false);
    assert.equal(instance.adapter, null);
    assert.equal(instance.status.availability, "unavailable");
    assert.match(instance.status.message ?? "", /did not provide a semantic adapter/);
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
      activeTurnId: null,
      lastRuntimeEvent: null,
      lastRuntimeEventAt: null,
      updatedAt: directory.getBinding("chat-1")?.updatedAt,
    });
    assert.equal(directory.getHarness("chat-1"), "codex");
    assert.equal(directory.resolveRoutableSession("chat-1")?.instanceId, "work");
  });

  it("recovers persisted cwd, model, active turn, and last runtime event from bindings", () => {
    const directory = getHarnessSessionDirectory();
    directory.clear();

    directory.upsert({
      chatId: "chat-2",
      harnessName: "codex",
      instanceId: "codex-work",
      status: "running",
      resumeCursor: "thread-2",
      runtimeMode: "workspace-write",
      runtimePayload: {
        workdir: "/repo",
        model: "gpt-5.4",
        activeTurnId: "turn-7",
        lastRuntimeEvent: "turn.started",
        lastRuntimeEventAt: "2026-05-27T00:00:00.000Z",
      },
    });

    assert.deepEqual(directory.resolveRecoveryState("chat-2"), {
      chatId: "chat-2",
      harnessName: "codex",
      instanceId: "codex-work",
      resumeCursor: "thread-2",
      runtimeMode: "workspace-write",
      workdir: "/repo",
      model: "gpt-5.4",
      activeTurnId: "turn-7",
      lastRuntimeEvent: "turn.started",
      lastRuntimeEventAt: "2026-05-27T00:00:00.000Z",
    });
  });
});

describe("resolveHarnessName", () => {
  it("uses codex as the central default when no chat or persona harness is selected", () => {
    assert.equal(resolveHarnessName(null, null), "codex");
  });

  it("allows the central default harness to be changed", () => {
    config.default_harness = "claude";

    assert.equal(resolveHarnessName(null, null), "claude");
  });

  it("treats stored app as default selection instead of a provider", () => {
    config.default_harness = "pi";

    assert.equal(resolveHarnessName(null, { harness: "app" }), "pi");
  });

  it("can disable the central default", () => {
    config.default_harness = "";

    assert.equal(resolveHarnessName(null, null), null);
  });
});
