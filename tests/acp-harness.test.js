import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAcpHarness } from "../harnesses/acp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

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
      ["claude", "claude", "Claude"],
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

  it("runs ACP agents that only advertise the standard loadSession capability", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js"), "--minimal-capabilities"],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:minimal",
    });
    assert.ok(adapter);

    await adapter.startSession({ chatId: "minimal-chat" });
    const result = await adapter.sendTurn({
      chatId: "minimal-chat",
      input: "session method",
      messages: [{ role: "user", content: [{ type: "text", text: "session method" }] }],
    });

    assert.deepEqual(result.response, [{ type: "markdown", text: "session/new" }]);
    assert.equal(adapter.listSessions()[0]?.resumeCursor, "mock-session-1");
    assert.deepEqual(adapter.listSessions()[0]?.capabilities, {
      supportsResume: true,
      supportsCancel: true,
      supportsLiveInput: false,
      supportsApprovals: true,
      supportsWorkdir: true,
      supportsSandboxConfig: true,
      supportsModelSelection: true,
      supportsReasoningEffort: true,
      supportsSessionFork: false,
      supportsRollback: false,
      supportsUserInputRequests: true,
    });
  });

  it("resumes loadSession-only ACP agents with session/load", async () => {
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js"), "--minimal-capabilities"],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:minimal-resume",
    });
    assert.ok(adapter);

    await adapter.startSession({ chatId: "minimal-resume-chat", resumeCursor: "existing-session" });
    const result = await adapter.sendTurn({
      chatId: "minimal-resume-chat",
      input: "session method",
      messages: [{ role: "user", content: [{ type: "text", text: "session method" }] }],
    });

    assert.deepEqual(result.response, [{ type: "markdown", text: "session/load" }]);
    assert.equal(adapter.listSessions()[0]?.resumeCursor, "existing-session");
  });

  it("reports fork as unavailable when an ACP agent does not advertise session/fork", async () => {
    const harness = createAcpHarness({
      name: "codex",
      label: "Codex",
      sessionKind: "codex",
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js"), "--minimal-capabilities"],
      },
    });
    /** @type {string[]} */
    const replies = [];

    const handled = await harness.handleCommand({
      chatId: "minimal-fork-chat",
      command: "fork",
      chatInfo: {
        chat_id: "minimal-fork-chat",
        harness_session_kind: "codex",
        harness_session_id: "mock-session-1",
      },
      context: /** @type {ExecuteActionContext} */ ({
        chatId: "minimal-fork-chat",
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
        save: async () => {
          throw new Error("fork should not save without provider support");
        },
        push: async () => {
          throw new Error("fork should not push without provider support");
        },
        pop: async () => null,
      },
    });

    assert.equal(handled, true);
    assert.match(replies[0] ?? "", /Codex ACP fork failed: ACP agent does not advertise session\/fork capability\./);
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

  it("bridges ACP elicitation requests to user input choices", async () => {
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
      await adapter.startSession({ chatId: "elicitation-chat" });
      const result = await adapter.sendTurn({
        chatId: "elicitation-chat",
        input: "elicitation",
        messages: [{ role: "user", content: [{ type: "text", text: "elicitation" }] }],
        hooks: {
          onAskUser: async (_question, options) => options.includes("Complete") ? "Complete" : options[0] ?? "",
        },
      });

      assert.deepEqual(result.response, [{
        type: "markdown",
        text: "{\"action\":\"accept\",\"content\":{\"strategy\":\"complete\"}}",
      }]);
      assert.ok(events.some((event) => event.type === "user-input.requested"));
      assert.ok(events.some((event) => event.type === "user-input.resolved"));
    } finally {
      unsubscribe?.();
    }
  });

  it("allows adapter callers to resolve ACP elicitation requests by request id", async () => {
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

    const unsubscribe = adapter.subscribeEvents?.((event) => {
      if (event.type === "user-input.requested" && event.request && typeof event.request === "object" && "id" in event.request && typeof event.request.id === "string") {
        setTimeout(() => {
          void adapter.respondToUserInput(event.request.id, {
            action: "accept",
            content: { strategy: "conservative" },
          });
        }, 0);
      }
    });
    try {
      await adapter.startSession({ chatId: "elicitation-chat-adapter" });
      const result = await adapter.sendTurn({
        chatId: "elicitation-chat-adapter",
        input: "elicitation",
        messages: [{ role: "user", content: [{ type: "text", text: "elicitation" }] }],
        hooks: {
          onAskUser: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return "Complete";
          },
        },
      });

      assert.deepEqual(result.response, [{
        type: "markdown",
        text: "{\"action\":\"accept\",\"content\":{\"strategy\":\"conservative\"}}",
      }]);
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

  it("surfaces unknown ACP extension requests and returns method-not-found", async () => {
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
      await adapter.startSession({ chatId: "extension-chat" });
      const result = await adapter.sendTurn({
        chatId: "extension-chat",
        input: "unknown extension",
        messages: [{ role: "user", content: [{ type: "text", text: "unknown extension" }] }],
      });

      assert.match(result.response[0]?.text ?? "", /Unsupported ACP client request method: madabot\/unknown/);
      assert.ok(events.some((event) => event.type === "extension.request" && event.method === "madabot/unknown"));
    } finally {
      unsubscribe?.();
    }
  });

  it("emits file changes for ACP fs writes and direct adapter writes", async () => {
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
        const change = /** @type {{ path?: unknown, kind?: unknown, source?: unknown, newText?: unknown, diff?: unknown }} */ (fileChanges[0]?.change ?? {});
        assert.ok(String(change.path ?? "").startsWith(tempDir));
        assert.equal(change.kind, "add");
        assert.equal(typeof change.newText, "string");
        if (prompt === "fs write") {
          assert.equal(change.source, "tool");
          assert.match(String(change.diff ?? ""), /--- \/dev\/null/);
        } else {
          assert.equal(change.source, "snapshot");
          assert.equal(change.diff, undefined);
        }
      } finally {
        unsubscribe?.();
      }
    }
  });

  it("emits snapshot file changes for unmarked ACP-side renames", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-direct-rename-"));
    await fs.writeFile(path.join(tempDir, "before-rename.txt"), "rename me\n", "utf8");
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:direct-rename",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "direct-rename-chat", runConfig: { workdir: tempDir } });
      await adapter.sendTurn({
        chatId: "direct-rename-chat",
        input: "direct rename",
        messages: [{ role: "user", content: [{ type: "text", text: "direct rename" }] }],
        runConfig: { workdir: tempDir },
      });

      const fileChanges = events.filter((event) => event.type === "file-change.completed");
      assert.deepEqual(
        fileChanges.map((event) => {
          const change = /** @type {{ path?: unknown, kind?: unknown, source?: unknown, diff?: unknown, oldText?: unknown, newText?: unknown }} */ (event.change ?? {});
          return {
            provider: event.provider,
            path: path.relative(tempDir, String(change.path ?? "")),
            kind: change.kind,
            source: change.source,
            fromSnapshot: /** @type {{ raw?: { source?: unknown } }} */ (event).raw?.source,
            hasPrebuiltDiff: change.diff !== undefined,
            oldText: change.oldText,
            newText: change.newText,
          };
        }),
        [
          {
            provider: "acp",
            path: "after-rename.txt",
            kind: "add",
            source: "snapshot",
            fromSnapshot: "workdir-snapshot",
            hasPrebuiltDiff: false,
            oldText: undefined,
            newText: "rename me\n",
          },
          {
            provider: "acp",
            path: "before-rename.txt",
            kind: "delete",
            source: "snapshot",
            fromSnapshot: "workdir-snapshot",
            hasPrebuiltDiff: false,
            oldText: "rename me\n",
            newText: undefined,
          },
        ],
      );
    } finally {
      unsubscribe?.();
    }
  });

  it("emits large unreported snapshot file-change batches as semantic events", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-snapshot-burst-"));
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:snapshot-burst",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "snapshot-burst-chat", runConfig: { workdir: tempDir } });
      await adapter.sendTurn({
        chatId: "snapshot-burst-chat",
        input: "many snapshot files",
        messages: [{ role: "user", content: [{ type: "text", text: "many snapshot files" }] }],
        runConfig: { workdir: tempDir },
      });

      const fileChanges = events.filter((event) => event.type === "file-change.completed");
      assert.equal(fileChanges.length, 30);
      assert.ok(fileChanges.every((event) => {
        const change = /** @type {{ source?: unknown, diff?: unknown, oldText?: unknown, newText?: unknown }} */ (event.change ?? {});
        return change.source === "snapshot"
          && change.diff === undefined
          && change.oldText === undefined
          && typeof change.newText === "string";
      }));
      assert.equal(events.some((event) => event.type === "runtime.warning"
        && /Skipped 30 unreported snapshot file changes/.test(String(event.message ?? ""))), false);
    } finally {
      unsubscribe?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reverts denied protected direct writes before transport file-change delivery", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-protected-direct-"));
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
      await adapter.startSession({
        chatId: "protected-direct-chat",
        runConfig: { workdir: tempDir, protectedPaths: ["direct-write.txt"] },
      });
      await adapter.sendTurn({
        chatId: "protected-direct-chat",
        input: "direct write",
        messages: [{ role: "user", content: [{ type: "text", text: "direct write" }] }],
        runConfig: { workdir: tempDir, protectedPaths: ["direct-write.txt"] },
        hooks: {
          onAskUser: async () => "Deny",
        },
      });

      await assert.rejects(fs.readFile(path.join(tempDir, "direct-write.txt"), "utf8"));
      assert.equal(events.some((event) => event.type === "file-change.completed"), false);
      assert.ok(events.some((event) => event.type === "tool.failed"));
    } finally {
      unsubscribe?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows approved protected ACP fs writes and emits the file change", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-protected-fs-"));
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
      await adapter.startSession({
        chatId: "protected-fs-chat",
        runConfig: { workdir: tempDir, protectedPaths: ["acp-fs-write.txt"] },
      });
      await adapter.sendTurn({
        chatId: "protected-fs-chat",
        input: "fs write",
        messages: [{ role: "user", content: [{ type: "text", text: "fs write" }] }],
        runConfig: { workdir: tempDir, protectedPaths: ["acp-fs-write.txt"] },
        hooks: {
          onAskUser: async () => "Allow once",
        },
      });

      assert.equal(await fs.readFile(path.join(tempDir, "acp-fs-write.txt"), "utf8"), "written through acp fs");
      assert.equal(events.filter((event) => event.type === "file-change.completed").length, 1);
    } finally {
      unsubscribe?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves ACP diff-only file change kinds and unified diffs", async () => {
    for (const [prompt, expectedKind, expectedPath] of [
      ["diff only add", "add", "diff-only-add.js"],
      ["diff only update", "update", "diff-only-update.js"],
      ["diff only delete", "delete", "diff-only-delete.js"],
    ]) {
      const harness = createAcpHarness({
        config: {
          command: process.execPath,
          args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
        },
      });
      const adapter = harness.createAdapter?.({
        name: "acp",
        instanceId: "test",
        continuationKey: `acp:${prompt}`,
      });
      assert.ok(adapter);

      /** @type {Array<Record<string, unknown>>} */
      const events = [];
      const unsubscribe = adapter.subscribeEvents?.((event) => {
        events.push(event);
      });
      try {
        await adapter.startSession({ chatId: `${prompt}-chat` });
        await adapter.sendTurn({
          chatId: `${prompt}-chat`,
          input: prompt,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        });

        const fileChanges = events.filter((event) => event.type === "file-change.completed");
        assert.equal(fileChanges.length, 1);
        const change = /** @type {{ path?: unknown, kind?: unknown, diff?: unknown, oldText?: unknown, newText?: unknown }} */ (fileChanges[0]?.change ?? {});
        assert.equal(change.path, expectedPath);
        assert.equal(change.kind, expectedKind);
        assert.equal(typeof change.diff, "string");
        assert.equal(change.oldText, undefined);
        assert.equal(change.newText, undefined);
      } finally {
        unsubscribe?.();
      }
    }
  });

  it("does not emit ACP file changes for configured ignored runtime-state paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-ignored-file-change-"));
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:ignored-file-change",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "ignored-file-change-chat", runConfig: { workdir: tempDir } });
      const result = await adapter.sendTurn({
        chatId: "ignored-file-change-chat",
        input: "ignored file change",
        messages: [{ role: "user", content: [{ type: "text", text: "ignored file change" }] }],
        runConfig: { workdir: tempDir, ignoredFileChangePaths: ["auth_info_baileys/**"] },
      });

      assert.deepEqual(result.response, [{ type: "markdown", text: "ignored file change done" }]);
      assert.equal(events.some((event) => event.type === "file-change.completed"), false);
    } finally {
      unsubscribe?.();
    }
  });

  it("still emits ACP file changes that are only gitignored", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-gitignored-file-change-"));
    await execFileAsync("git", ["init"], { cwd: tempDir });
    await fs.writeFile(path.join(tempDir, ".gitignore"), "diff-only-add.js\n", "utf8");
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:gitignored-file-change",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "gitignored-file-change-chat", runConfig: { workdir: tempDir } });
      await adapter.sendTurn({
        chatId: "gitignored-file-change-chat",
        input: "diff only add",
        messages: [{ role: "user", content: [{ type: "text", text: "diff only add" }] }],
        runConfig: { workdir: tempDir },
      });

      const fileChanges = events.filter((event) => event.type === "file-change.completed");
      assert.equal(fileChanges.length, 1);
      assert.equal(/** @type {{ change?: { path?: unknown } }} */ (fileChanges[0]).change?.path, "diff-only-add.js");
    } finally {
      unsubscribe?.();
    }
  });

  it("still enforces protected paths before suppressing ignored ACP file changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-ignored-protected-"));
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:ignored-protected",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      const runConfig = {
        workdir: tempDir,
        protectedPaths: ["direct-write.txt"],
        ignoredFileChangePaths: ["direct-write.txt"],
      };
      await adapter.startSession({ chatId: "ignored-protected-chat", runConfig });
      await adapter.sendTurn({
        chatId: "ignored-protected-chat",
        input: "direct write",
        messages: [{ role: "user", content: [{ type: "text", text: "direct write" }] }],
        runConfig,
        hooks: {
          onAskUser: async () => "Deny",
        },
      });

      await assert.rejects(fs.readFile(path.join(tempDir, "direct-write.txt"), "utf8"));
      assert.equal(events.some((event) => event.type === "file-change.completed"), false);
      assert.ok(events.some((event) => event.type === "tool.failed"));
    } finally {
      unsubscribe?.();
    }
  });

  it("corrects provider add events for files that existed at run start", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-mislabel-existing-"));
    await fs.writeFile(path.join(tempDir, "existing-mislabel.js"), "export const value = 1;\n", "utf8");
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:mislabel-existing-add",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "mislabel-existing-chat", runConfig: { workdir: tempDir } });
      await adapter.sendTurn({
        chatId: "mislabel-existing-chat",
        input: "mislabel existing add",
        messages: [{ role: "user", content: [{ type: "text", text: "mislabel existing add" }] }],
        runConfig: { workdir: tempDir },
      });

      const fileChanges = events.filter((event) => event.type === "file-change.completed");
      assert.equal(fileChanges.length, 1);
      const change = /** @type {{ path?: unknown, kind?: unknown, diff?: unknown, oldText?: unknown, newText?: unknown }} */ (fileChanges[0]?.change ?? {});
      assert.equal(change.path, path.join(tempDir, "existing-mislabel.js"));
      assert.equal(change.kind, "update");
      assert.equal(change.oldText, "export const value = 1;\n");
      assert.equal(change.newText, "export const value = 2;\n");
      assert.match(String(change.diff ?? ""), /-export const value = 1;/);
      assert.match(String(change.diff ?? ""), /\+export const value = 2;/);
    } finally {
      unsubscribe?.();
    }
  });

  it("adds transport-ready diffs when ACP providers send old/new text without a diff", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-old-new-no-diff-"));
    await fs.writeFile(path.join(tempDir, "existing-no-diff.js"), "export const value = 1;\n", "utf8");
    const harness = createAcpHarness({
      config: {
        command: process.execPath,
        args: [path.join(__dirname, "fixtures", "acp-mock-agent.js")],
      },
    });
    const adapter = harness.createAdapter?.({
      name: "acp",
      instanceId: "test",
      continuationKey: "acp:old-new-no-diff",
    });
    assert.ok(adapter);

    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      events.push(event);
    });
    try {
      await adapter.startSession({ chatId: "old-new-no-diff-chat", runConfig: { workdir: tempDir } });
      await adapter.sendTurn({
        chatId: "old-new-no-diff-chat",
        input: "old new no diff",
        messages: [{ role: "user", content: [{ type: "text", text: "old new no diff" }] }],
        runConfig: { workdir: tempDir },
      });

      const fileChanges = events.filter((event) => event.type === "file-change.completed");
      assert.equal(fileChanges.length, 1);
      const change = /** @type {{ path?: unknown, kind?: unknown, diff?: unknown, oldText?: unknown, newText?: unknown }} */ (fileChanges[0]?.change ?? {});
      assert.equal(change.path, path.join(tempDir, "existing-no-diff.js"));
      assert.equal(change.kind, "update");
      assert.equal(change.oldText, "export const value = 1;\n");
      assert.equal(change.newText, "export const value = 2;\n");
      assert.match(String(change.diff ?? ""), /-export const value = 1;/);
      assert.match(String(change.diff ?? ""), /\+export const value = 2;/);
    } finally {
      unsubscribe?.();
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

  it("applies arbitrary ACP config values from run config", async () => {
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

    await adapter.startSession({ chatId: "generic-config-chat", runConfig: { configValues: { "reasoning-effort": "low" } } });
    const result = await adapter.sendTurn({
      chatId: "generic-config-chat",
      input: "config",
      messages: [{ role: "user", content: [{ type: "text", text: "config" }] }],
      runConfig: { configValues: { "reasoning-effort": "low" } },
    });

    assert.deepEqual(result.response, [{ type: "markdown", text: "model=default mode=code effort=low" }]);
  });

  it("exposes ACP rollback RFDs through the adapter", async () => {
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

    assert.deepEqual(await adapter.rollbackThread("mock-session-1", 2), {
      sessionId: "mock-session-1",
      rolledBackTurns: 2,
    });
  });
});
