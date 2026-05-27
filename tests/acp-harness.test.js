import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpHarness } from "../harnesses/acp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("ACP harness", () => {
  it("runs an ACP stdio agent and emits canonical runtime events", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:test",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "chat-1" });
      const result = await adapter.sendTurn({
        chatId: "chat-1",
        input: "Run the mock",
        messages: [{ role: "user", content: [{ type: "text", text: "Run the mock" }] }],
      });

      assert.deepEqual(result.response, [{ type: "markdown", text: "Main result." }]);
      assert.equal(adapter.listSessions()[0]?.resumeCursor, "mock-session-1");
      assert.ok(events.some((event) => event.type === "plan.updated"));
      assert.ok(events.some((event) => event.type === "subagent.completed"));
      assert.ok(events.some((event) => event.type === "file-change.completed"));
      assert.ok(events.some((event) => event.type === "tool.started"));
      assert.ok(events.some((event) => event.type === "content.delta"));
      assert.ok(events.some((event) => event.type === "item.completed"));
    } finally {
      unsubscribe?.();
    }
  });

  it("forks provider sessions through the ACP session/fork RFD", async () => {
    for (const [name, kind, label] of [
      ["codex", "codex", "Codex"],
      ["claude-agent-sdk", "claude-sdk", "Claude"],
      ["pi", "pi", "Pi"],
    ]) {
      const harness = createAcpHarness({
        name,
        label,
        sessionKind: kind,
        config: {
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
        },
      });
      /** @type {HarnessSessionRef | null} */
      let saved = null;
      /** @type {HarnessForkStackEntry[]} */
      const pushed = [];
      /** @type {string[]} */
      const replies = [];

      const handled = await harness.handleCommand({
        chatId: `${name}-chat`,
        command: "fork",
        chatInfo: {
          chat_id: `${name}-chat`,
          harness_session_kind: kind,
          harness_session_id: "mock-session-1",
        },
        context: /** @type {ExecuteActionContext} */ ({
          chatId: `${name}-chat`,
          senderIds: [],
          content: [],
          getIsAdmin: async () => true,
          send: async () => undefined,
          reply: async (event) => {
            replies.push(event.kind === "content" && typeof event.content === "string" ? event.content : JSON.stringify(event));
          },
          reactToMessage: async () => {},
          select: async () => "",
          confirm: async () => true,
        }),
        sessionForkControl: {
          getHistory: async () => [],
          save: async (_chatId, session) => {
            saved = session;
          },
          push: async (_chatId, entry) => {
            pushed.push(entry);
          },
          pop: async () => null,
        },
      });

      assert.equal(handled, true);
      assert.deepEqual(saved, { id: "mock-session-fork", kind });
      assert.deepEqual(pushed, [{ id: "mock-session-1", kind, label: `${label} ACP session` }]);
      assert.match(replies[0] ?? "", new RegExp(`Forked ${label} ACP session`));
    }
  });

  it("bridges ACP permission requests to chat-facing choices", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:test",
    });
    assert.ok(adapter);

    /** @type {Array<{ question: string, options: string[], descriptions?: string[] }>} */
    const prompts = [];
    await adapter.startSession({ chatId: "permission-chat" });
    const result = await adapter.sendTurn({
      chatId: "permission-chat",
      input: "permission",
      messages: [{ role: "user", content: [{ type: "text", text: "permission" }] }],
      hooks: {
        onAskUser: async (question, options, _preamble, descriptions) => {
          prompts.push({ question, options, descriptions });
          return "Allow once";
        },
      },
    });

    assert.equal(prompts[0]?.question, "Allow *Sensitive mock operation*?");
    assert.deepEqual(prompts[0]?.options, ["Allow once", "Reject once"]);
    assert.deepEqual(result.response, [{
      type: "markdown",
      text: "{\"outcome\":{\"outcome\":\"selected\",\"optionId\":\"allow-once\"}}",
    }]);
  });

  it("allows adapter callers to resolve ACP permission requests by request id", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:test",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
      if (event.type === "request.opened" && event.request && typeof event.request === "object" && "id" in event.request && typeof event.request.id === "string") {
        setTimeout(() => {
          void adapter.respondToRequest(event.request.id, { optionId: "allow-once" });
        }, 0);
      }
    });
    try {
      await adapter.startSession({ chatId: "permission-chat-adapter" });
      const result = await adapter.sendTurn({
        chatId: "permission-chat-adapter",
        input: "permission",
        messages: [{ role: "user", content: [{ type: "text", text: "permission" }] }],
        hooks: {
          onAskUser: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return "Reject once";
          },
        },
      });

      assert.deepEqual(result.response, [{
        type: "markdown",
        text: "{\"outcome\":{\"outcome\":\"selected\",\"optionId\":\"allow-once\"}}",
      }]);
      assert.ok(events.some((event) => event.type === "request.opened"));
      assert.ok(events.some((event) => event.type === "request.resolved"));
    } finally {
      unsubscribe?.();
    }
  });

  it("executes ACP terminal requests and emits command events", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-terminal-"));
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:test",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "terminal-chat", runConfig: { workdir: tempDir } });
      const result = await adapter.sendTurn({
        chatId: "terminal-chat",
        input: "terminal",
        messages: [{ role: "user", content: [{ type: "text", text: "terminal" }] }],
        runConfig: { workdir: tempDir },
      });

      assert.deepEqual(result.response, [{ type: "markdown", text: "terminal ok" }]);
      assert.ok(events.some((event) => event.type === "command.started"));
      assert.ok(events.some((event) => event.type === "command.completed"));
    } finally {
      unsubscribe?.();
    }
  });

  it("emits file changes for ACP fs writes and direct adapter writes without diffs", async () => {
    for (const prompt of ["fs write", "direct write"]) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `acp-${prompt.replace(" ", "-")}-`));
      const harness = createAcpHarness({
        config: {
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
        },
      });
      const adapter = harness.createAdapter?.({
        name: "acp",
        instanceId: "test",
        continuationKey: "acp:test",
      });
      assert.ok(adapter);

      /** @type {Array<Record<string, unknown>>} */
      const events = [];
      const unsubscribe = adapter.subscribeEvents?.((event) => {
        events.push(event);
      });
      try {
        await adapter.startSession({ chatId: `${prompt}-chat`, runConfig: { workdir: tempDir } });
        await adapter.sendTurn({
          chatId: `${prompt}-chat`,
          input: prompt,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          runConfig: { workdir: tempDir },
        });

        const fileChanges = events.filter((event) => event.type === "file-change.completed");
        assert.equal(fileChanges.length, 1);
        assert.ok(String(fileChanges[0]?.change?.path ?? "").startsWith(tempDir));
      } finally {
        unsubscribe?.();
      }
    }
  });

  it("applies ACP session config options for model and reasoning effort", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:test",
    });
    assert.ok(adapter);

    await adapter.startSession({ chatId: "config-chat", runConfig: { model: "model-a", mode: "plan", reasoningEffort: "high" } });
    const result = await adapter.sendTurn({
      chatId: "config-chat",
      input: "config",
      messages: [{ role: "user", content: [{ type: "text", text: "config" }] }],
      runConfig: { model: "model-a", mode: "plan", reasoningEffort: "high" },
    });

    assert.deepEqual(result.response, [{ type: "markdown", text: "model=model-a mode=plan effort=high" }]);
  });

  it("exposes ACP read and rollback RFDs through the adapter", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:test",
    });
    assert.ok(adapter);

    await adapter.startSession({ chatId: "rfd-chat" });
    await adapter.sendTurn({
      chatId: "rfd-chat",
      input: "Run the mock",
      messages: [{ role: "user", content: [{ type: "text", text: "Run the mock" }] }],
    });

    assert.deepEqual(await adapter.readThread("mock-session-1"), {
      thread: {
        id: "mock-session-1",
        preview: "Mock thread",
        turns: [{ status: "completed", items: [] }],
      },
    });
    assert.deepEqual(await adapter.rollbackThread("mock-session-1", 2), {
      sessionId: "mock-session-1",
      rolledBackTurns: 2,
    });
  });
});
