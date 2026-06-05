import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessSessionDirectory } from "../harnesses/session-directory.js";
import { createHarnessSessionBindingService } from "../conversation/harness-session-binding.js";

/**
 * @param {{
 *   resumeCursor?: string | null,
 *   stopResult?: boolean,
 *   stoppedStatus?: "ready" | "stopped" | "error",
 * }} [options]
 * @returns {{
 *   adapter: HarnessAdapter,
 *   started: unknown[],
 *   stopped: string[],
 * }}
 */
function createAdapterFixture(options = {}) {
  const started = [];
  const stopped = [];
  const sessions = new Map();
  return {
    started,
    stopped,
    adapter: {
      async startSession(input) {
        started.push(input);
        const session = {
          chatId: input.chatId,
          status: "ready",
          resumeCursor: options.resumeCursor ?? input.resumeCursor ?? null,
        };
        sessions.set(input.chatId, session);
        return session;
      },
      async sendTurn() {
        throw new Error("not used");
      },
      injectMessage: async () => false,
      stopSession: async (chatId) => {
        stopped.push(String(chatId));
        return options.stopResult ?? true;
      },
      hasSession: () => true,
      listSessions: () => [...sessions.values()].map((session) => ({
        ...session,
        status: options.stoppedStatus ?? session.status,
      })),
      subscribeEvents: () => () => {},
    },
  };
}

function createService(options = {}) {
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
    llmClient: {},
    resolveHarnessInstanceForChat: options.resolveHarnessInstanceForChat ?? (async () => null),
  });
  return { service, directory, saved };
}

describe("createHarnessSessionBindingService", () => {
  it("starts adapter turns with the durable cursor only when the selected harness kind matches", async () => {
    const { adapter, started } = createAdapterFixture({ resumeCursor: "adapter-cursor" });
    const { service, directory, saved } = createService();

    const binding = await service.beginTurn({
      chatId: "chat-1",
      chatInfo: {
        harness_session_kind: "codex",
        harness_session_id: "stored-cursor",
      },
      harnessName: "codex",
      harnessInstance: {
        instanceId: "work",
        adapter,
      },
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
      chatInfo: {
        harness_session_kind: "claude",
        harness_session_id: "wrong-kind-cursor",
      },
      harnessName: "codex",
      harnessInstance: {
        instanceId: "work",
        adapter,
      },
      runConfig: {},
      turnId: "turn-2",
    });

    assert.equal(started[0].resumeCursor, null);
  });

  it("clears runtime and durable session state through one seam", async () => {
    const { adapter, stopped } = createAdapterFixture({ stopResult: true });
    const { service, directory, saved } = createService({
      resolveHarnessInstanceForChat: async () => ({ adapter }),
    });
    directory.upsert({
      chatId: "chat-3",
      harnessName: "codex",
      instanceId: "work",
      status: "ready",
      resumeCursor: "cursor",
    });

    const stoppedSession = await service.clearActiveSession("chat-3", {});

    assert.equal(stoppedSession, true);
    assert.deepEqual(stopped, ["chat-3"]);
    assert.equal(directory.getBinding("chat-3"), null);
    assert.deepEqual(saved, [{ chatId: "chat-3", session: null }]);
  });
});
