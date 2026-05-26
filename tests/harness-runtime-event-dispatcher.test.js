import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHarnessRuntimeEventDispatcher } from "../harnesses/harness-runtime-event-dispatcher.js";
import { createNdjsonRawEventLogger } from "../harnesses/raw-event-log.js";

describe("createHarnessRuntimeEventDispatcher", () => {
  it("projects canonical runtime events into hooks and result state", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    /** @type {string[]} */
    const responses = [];
    /** @type {Array<{ cost: string, tokens: UsageTokens }>} */
    const usageEvents = [];
    let composingCount = 0;
    let pausedCount = 0;

    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [{ role: "user", content: [{ type: "text", text: "Ship it" }] }],
      hooks: {
        onComposing: async () => {
          composingCount += 1;
        },
        onPaused: async () => {
          pausedCount += 1;
        },
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
        onLlmResponse: async (text) => {
          responses.push(text);
        },
        onUsage: async (cost, tokens) => {
          usageEvents.push({ cost, tokens });
        },
      },
    });

    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "pi",
      text: "Reading files.",
      status: "updated",
      raw: { type: "message_update" },
    });
    await dispatcher.handleEvent({
      type: "assistant.completed",
      provider: "pi",
      text: "Done.",
      contentType: "markdown",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 2,
        cost: 0.0123,
      },
    });

    assert.deepEqual(reasoningEvents, [{
      status: "updated",
      summaryParts: [],
      contentParts: ["Reading files."],
      text: "Reading files.",
    }]);
    assert.deepEqual(responses, ["Done."]);
    assert.deepEqual(dispatcher.result.response, [{ type: "markdown", text: "Done." }]);
    assert.deepEqual(dispatcher.result.usage, {
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 2,
      cost: 0.0123,
    });
    assert.deepEqual(usageEvents, [{
      cost: "0.012300",
      tokens: {
        prompt: 10,
        completion: 5,
        cached: 2,
      },
    }]);
    assert.equal(composingCount, 0);
    assert.equal(pausedCount, 0);
  });

  it("tracks generic tool lifecycle events for inspect updates", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const toolCalls = [];
    /** @type {Array<MessageInspectState | null>} */
    const inspectStates = [];
    let composingCount = 0;
    let pausedCount = 0;

    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [],
      workdir: "/repo",
      hooks: {
        onComposing: async () => {
          composingCount += 1;
        },
        onPaused: async () => {
          pausedCount += 1;
        },
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          return {
            transportHandleId: "msg-1",
            update: async () => {},
            setInspect: (state) => {
              inspectStates.push(state);
            },
          };
        },
      },
    });

    await dispatcher.handleEvent({
      type: "tool.started",
      provider: "pi",
      tool: {
        id: "tool-1",
        name: "Read",
        arguments: { file_path: "README.md" },
      },
    });
    await dispatcher.handleEvent({
      type: "tool.updated",
      provider: "pi",
      tool: {
        id: "tool-1",
        name: "Read",
        arguments: { file_path: "README.md" },
        output: "partial",
      },
    });
    await dispatcher.handleEvent({
      type: "tool.completed",
      provider: "pi",
      tool: {
        id: "tool-1",
        name: "Read",
        arguments: { file_path: "README.md" },
        output: "final",
      },
    });

    assert.deepEqual(toolCalls, [{
      id: "tool-1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "README.md" }),
    }]);
    assert.equal(pausedCount, 0);
    assert.equal(composingCount, 0);
    assert.equal(inspectStates.length, 2);
    assert.equal(inspectStates.at(-1)?.kind, "tool");
    assert.equal(
      inspectStates.at(-1)?.kind === "tool" ? inspectStates.at(-1)?.output : null,
      "final",
    );
  });

  it("projects command and file-read runtime events into progress hooks", async () => {
    /** @type {Array<{ command: string, status: "started" | "completed" | "failed", output?: string }>} */
    const commands = [];
    /** @type {Array<{ command: string, paths: string[] }>} */
    const fileReads = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "codex",
      messages: [],
      hooks: {
        onCommand: async (event) => {
          commands.push(event);
        },
        onFileRead: async (event) => {
          fileReads.push(event);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "file-read.started",
      provider: "codex",
      fileRead: {
        command: "sed -n '1,20p' src/app.js",
        paths: ["src/app.js"],
      },
    });
    await dispatcher.handleEvent({
      type: "command.started",
      provider: "codex",
      command: {
        command: "pnpm type-check",
        status: "started",
      },
    });
    await dispatcher.handleEvent({
      type: "command.completed",
      provider: "codex",
      command: {
        command: "pnpm type-check",
        status: "completed",
        output: "ok",
      },
    });

    assert.deepEqual(fileReads, [{
      command: "sed -n '1,20p' src/app.js",
      paths: ["src/app.js"],
    }]);
    assert.deepEqual(commands, [
      {
        command: "pnpm type-check",
        status: "started",
      },
      {
        command: "pnpm type-check",
        status: "completed",
        output: "ok",
      },
    ]);
  });

  it("captures raw provider events as replayable ndjson without changing hook projection", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-runtime-events-"));
    const logPath = path.join(tempDir, "events.ndjson");
    /** @type {string[]} */
    const responses = [];
    try {
      const dispatcher = createHarnessRuntimeEventDispatcher({
        provider: "codex",
        messages: [],
        rawEventLogger: createNdjsonRawEventLogger(logPath),
        hooks: {
          onLlmResponse: async (text) => {
            responses.push(text);
          },
        },
      });

      await dispatcher.handleEvent({
        type: "assistant.completed",
        provider: "codex",
        text: "Done.",
        contentType: "markdown",
        raw: { msg: { type: "agent_message_delta", delta: "Done." } },
      });

      const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), {
        provider: "codex",
        type: "assistant.completed",
        raw: { msg: { type: "agent_message_delta", delta: "Done." } },
      });
      assert.deepEqual(responses, ["Done."]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts session, turn, request, user-input, and file-change runtime events", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const fileChanges = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "codex",
      messages: [],
      hooks: {
        onFileChange: async (event) => {
          fileChanges.push(event);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "session.started",
      provider: "codex",
      session: {
        chatId: "chat-1",
        harnessName: "codex",
        instanceId: "work",
        status: "ready",
      },
    });
    await dispatcher.handleEvent({
      type: "turn.started",
      provider: "codex",
      turn: { id: "turn-1", chatId: "chat-1" },
    });
    await dispatcher.handleEvent({
      type: "request.opened",
      provider: "codex",
      request: {
        id: "approval-1",
        kind: "command",
        summary: "Run tests",
      },
    });
    await dispatcher.handleEvent({
      type: "user-input.requested",
      provider: "codex",
      request: {
        id: "question-1",
        questions: [{ id: "q1", question: "Which branch?", options: [] }],
      },
    });
    await dispatcher.handleEvent({
      type: "file-change.completed",
      provider: "codex",
      change: {
        path: "/repo/app.js",
        summary: "Updated app",
        kind: "update",
      },
    });
    await dispatcher.handleEvent({
      type: "turn.completed",
      provider: "codex",
      turn: { id: "turn-1", chatId: "chat-1", status: "completed" },
    });

    assert.deepEqual(fileChanges, [{
      path: "/repo/app.js",
      summary: "Updated app",
      kind: "update",
    }]);
    assert.deepEqual(dispatcher.result.response, []);
  });

  it("projects plan and subagent runtime events into chat hooks", async () => {
    /** @type {Array<import("../plan-presentation.js").PlanPresentation>} */
    const plans = [];
    /** @type {Array<{ text: string, metadata?: LlmResponseMetadata }>} */
    const responses = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks: {
        onPlan: async (presentation) => {
          plans.push(presentation);
        },
        onLlmResponse: async (text, metadata) => {
          responses.push({ text, ...(metadata ? { metadata } : {}) });
        },
      },
    });

    await dispatcher.handleEvent({
      type: "plan.updated",
      provider: "acp",
      plan: {
        explanation: "Ship ACP",
        entries: [
          { text: "Wire runtime events", status: "completed" },
          { text: "Handle subagents", status: "in_progress" },
        ],
      },
    });
    await dispatcher.handleEvent({
      type: "subagent.completed",
      provider: "acp",
      text: "Subagent found the bug.",
      metadata: {
        source: "subagent",
        threadId: "toolu-task-1",
        agentRole: "code-reviewer",
      },
    });

    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.summary, "*Plan*  _Working on: Handle subagents_");
    assert.deepEqual(responses, [{
      text: "Subagent found the bug.",
      metadata: {
        source: "subagent",
        threadId: "toolu-task-1",
        agentRole: "code-reviewer",
      },
    }]);
    assert.deepEqual(dispatcher.result.response, []);
  });
});
