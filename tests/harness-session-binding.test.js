import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessSessionDirectory } from "../harnesses/session-directory.js";
import { createHarnessSessionBindingService } from "../conversation/harness-session-binding.js";

/** @typedef {Parameters<HarnessAdapter["startSession"]>[0]} StartSessionInput */

/**
 * @param {unknown} client
 * @returns {LlmClient}
 */
function llmClient(client) {
  return /** @type {LlmClient} */ (/** @type {unknown} */ (client));
}

/**
 * @param {Partial<import("../store.js").ChatRow>} overrides
 * @returns {import("../store.js").ChatRow}
 */
function chatInfo(overrides) {
  return {
    chat_id: "test-chat",
    is_enabled: true,
    system_prompt: null,
    model: null,
    respond_on_any: false,
    respond_on_mention: true,
    respond_on_reply: false,
    respond_on: "mention",
    debug: false,
    media_to_text_models: {},
    model_roles: {},
    memory: false,
    memory_threshold: null,
    active_persona: null,
    harness: null,
    harness_cwd: null,
    output_visibility: {},
    harness_config: {},
    harness_session_id: null,
    harness_session_kind: null,
    harness_session_history: [],
    harness_fork_stack: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * @param {HarnessAdapter} adapter
 * @returns {import("../harnesses/registry.js").HarnessInstance}
 */
function harnessInstance(adapter) {
  return /** @type {import("../harnesses/registry.js").HarnessInstance} */ ({
    name: "codex",
    instanceId: "work",
    displayName: "Codex",
    supportsInstances: true,
    continuationKey: "codex:instance:work",
    capabilities: {
      supportsResume: true,
      supportsCancel: false,
      supportsLiveInput: false,
      supportsApprovals: false,
      supportsWorkdir: true,
      supportsSandboxConfig: false,
      supportsModelSelection: true,
      supportsReasoningEffort: false,
      supportsSessionFork: false,
      sessionModelSwitch: "unsupported",
      supportsRollback: false,
      supportsUserInputRequests: false,
    },
    available: true,
    status: { availability: "available" },
    harness: /** @type {AgentHarness} */ ({}),
    adapter,
  });
}

/**
 * @param {{
 *   resumeCursor?: string | null,
 *   stopResult?: boolean,
 *   stoppedStatus?: "ready" | "stopped" | "error",
 * }} [options]
 * @returns {{
 *   adapter: HarnessAdapter,
 *   started: StartSessionInput[],
 *   stopped: string[],
 * }}
 */
function createAdapterFixture(options = {}) {
  /** @type {StartSessionInput[]} */
  const started = [];
  /** @type {string[]} */
  const stopped = [];
  /** @type {Map<string, HarnessRuntimeSession>} */
  const sessions = new Map();
  return {
    started,
    stopped,
    adapter: {
      async startSession(input) {
        started.push(input);
        const session = /** @type {HarnessRuntimeSession} */ ({
          chatId: input.chatId,
          harnessName: "codex",
          instanceId: "work",
          continuationKey: "codex:instance:work",
          status: "ready",
          resumeCursor: options.resumeCursor ?? input.resumeCursor ?? null,
        });
        sessions.set(input.chatId, session);
        return session;
      },
      async sendTurn() {
        throw new Error("not used");
      },
      interruptTurn: async () => false,
      respondToRequest: async () => false,
      respondToUserInput: async () => false,
      injectMessage: async () => false,
      stopSession: async (chatId) => {
        stopped.push(String(chatId));
        return options.stopResult ?? true;
      },
      hasSession: () => true,
      stopAll: async () => {},
      listSessions: () => [...sessions.values()].map((session) => ({
        ...session,
        status: options.stoppedStatus ?? session.status,
      })),
      rollbackThread: async () => null,
      streamEvents: {
        async *[Symbol.asyncIterator]() {},
      },
      subscribeEvents: () => () => {},
    },
  };
}

/**
 * @param {{
 *   resolveHarnessInstanceForChat?: (chatInfo: import("../store.js").ChatRow | undefined) => Promise<import("../harnesses/registry.js").HarnessInstance | null>,
 *   log?: Pick<Console, "info" | "warn">,
 * }} [options]
 */
function createService(options = {}) {
  /** @type {Array<{ chatId: string, session: HarnessSessionRef | null }>} */
  const saved = [];
  const directory = createHarnessSessionDirectory();
  const service = createHarnessSessionBindingService({
    directory,
    saveHarnessSession: async (chatId, session) => {
      saved.push({ chatId, session });
    },
    archiveHarnessSession: async () => null,
    getHarnessSessionHistory: async () => [],
    restoreHarnessSession: async () => null,
    pushHarnessForkStack: async () => {},
    popHarnessForkStack: async () => null,
    getMessages: async () => [],
    llmClient: llmClient({}),
    resolveHarnessInstanceForChat: options.resolveHarnessInstanceForChat ?? (async () => null),
    ...(options.log ? { log: options.log } : {}),
  });
  return { service, directory, saved };
}

function createLogSink() {
  /** @type {Array<{ message: string, data: Record<string, unknown> }>} */
  const entries = [];
  return {
    entries,
    log: {
      info: (/** @type {string} */ message, /** @type {Record<string, unknown>} */ data = {}) => entries.push({ message, data }),
      warn: () => {},
    },
  };
}

describe("createHarnessSessionBindingService", () => {
  it("starts adapter turns with the durable cursor only when the selected harness kind matches", async () => {
    const { adapter, started } = createAdapterFixture({ resumeCursor: "adapter-cursor" });
    const { service, directory, saved } = createService();

    const binding = await service.beginTurn({
      chatId: "chat-1",
      chatInfo: chatInfo({
        harness_session_kind: "codex",
        harness_session_id: "stored-cursor",
      }),
      harnessName: "codex",
      harnessInstance: harnessInstance(adapter),
      runConfig: { workdir: "/repo", model: "gpt-test", sandboxMode: "workspace-write" },
      turnId: "turn-1",
    });

    assert.equal(started.length, 1);
    assert.equal(started[0].resumeCursor, "stored-cursor");
    assert.equal(binding.getResumeCursor(), "adapter-cursor");

    binding.markRunning();
    assert.deepEqual(directory.getBinding("chat-1"), {
      chatId: "chat-1",
      harnessName: "codex",
      instanceId: "work",
      status: "running",
      activeTurnId: "turn-1",
      resumeCursor: "adapter-cursor",
      runtimeMode: "workspace-write",
      runtimePayload: {
        workdir: "/repo",
        model: "gpt-test",
        reasoningEffort: null,
        approvalPolicy: null,
        approvalsReviewer: null,
      },
      lastRuntimeEvent: null,
      lastRuntimeEventAt: null,
      updatedAt: directory.getBinding("chat-1")?.updatedAt,
    });

    await binding.syncFromAdapter(adapter, "codex");
    assert.deepEqual(saved, [
      { chatId: "chat-1", session: { id: "adapter-cursor", kind: "codex" } },
    ]);
    assert.equal(directory.getBinding("chat-1")?.status, "ready");
  });

  it("does not resume a cursor saved for a different harness kind", async () => {
    const { adapter, started } = createAdapterFixture();
    const { service } = createService();

    await service.beginTurn({
      chatId: "chat-2",
      chatInfo: chatInfo({
        harness_session_kind: "claude",
        harness_session_id: "wrong-kind-cursor",
      }),
      harnessName: "codex",
      harnessInstance: harnessInstance(adapter),
      runConfig: {},
      turnId: "turn-2",
    });

    assert.equal(started[0].resumeCursor, null);
  });

  it("logs whether a turn attempted and accepted runtime session reattachment", async () => {
    const { adapter } = createAdapterFixture({ resumeCursor: "stored-cursor" });
    const { entries, log } = createLogSink();
    const { service } = createService({ log });

    await service.beginTurn({
      chatId: "chat-reattach",
      chatInfo: chatInfo({
        harness_session_kind: "codex",
        harness_session_id: "stored-cursor",
      }),
      harnessName: "codex",
      harnessInstance: harnessInstance(adapter),
      runConfig: { workdir: "/repo" },
      turnId: "turn-reattach-1",
    });

    const adapterStarted = entries.find((entry) => entry.message === "Agent runtime adapter session started.");
    assert.ok(adapterStarted);
    assert.deepEqual({
      chatId: adapterStarted.data.chatId,
      turnId: adapterStarted.data.turnId,
      inputResumeCursor: adapterStarted.data.inputResumeCursor,
      adapterResumeCursor: adapterStarted.data.adapterResumeCursor,
      reattachAttempted: adapterStarted.data.reattachAttempted,
      reattachAccepted: adapterStarted.data.reattachAccepted,
    }, {
      chatId: "chat-reattach",
      turnId: "turn-reattach-1",
      inputResumeCursor: "stored-cursor",
      adapterResumeCursor: "stored-cursor",
      reattachAttempted: true,
      reattachAccepted: true,
    });
  });

  it("clears runtime and durable session state through one seam", async () => {
    const { adapter, stopped } = createAdapterFixture({ stopResult: true });
    const { service, directory, saved } = createService({
      resolveHarnessInstanceForChat: async () => harnessInstance(adapter),
    });
    directory.upsert({
      chatId: "chat-3",
      harnessName: "codex",
      instanceId: "work",
      status: "ready",
      resumeCursor: "cursor",
    });

    const stoppedSession = await service.clearActiveSession("chat-3", chatInfo({}));

    assert.equal(stoppedSession, true);
    assert.deepEqual(stopped, ["chat-3"]);
    assert.equal(directory.getBinding("chat-3"), null);
    assert.deepEqual(saved, [{ chatId: "chat-3", session: null }]);
  });
});
