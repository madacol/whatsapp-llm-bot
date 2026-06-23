import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessRuntimeEventDispatcher } from "../harnesses/harness-runtime-event-dispatcher.js";
import { getHarnessRuntimeDiagnosticRaw, normalizeHarnessRuntimeEvent } from "../harnesses/harness-runtime-events.js";

describe("createHarnessRuntimeEventDispatcher", () => {
  it("adds stable runtime metadata without embedding diagnostic raw payloads", () => {
    const event = normalizeHarnessRuntimeEvent({
      type: "content.delta",
      provider: "codex",
      providerInstanceId: "codex-work",
      chatId: "chat-1",
      itemId: "assistant-1",
      text: "Done",
      contentType: "markdown",
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: { sequence: 1 },
      },
    }, {
      eventId: "evt-test",
      createdAt: "2026-05-27T00:00:00.000Z",
      providerRefs: {
        providerTurnId: "provider-turn-1",
        providerItemId: "provider-item-1",
      },
    });

    assert.equal(event.eventId, "evt-test");
    assert.equal(event.createdAt, "2026-05-27T00:00:00.000Z");
    assert.equal(event.providerInstanceId, "codex-work");
    assert.deepEqual(event.providerRefs, {
      providerTurnId: "provider-turn-1",
      providerItemId: "provider-item-1",
    });
    assert.equal("diagnosticRaw" in event, false);
    assert.equal("raw" in event, false);
    assert.deepEqual(getHarnessRuntimeDiagnosticRaw({
      type: "content.delta",
      provider: "codex",
      itemId: "assistant-1",
      text: "Done",
      contentType: "markdown",
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: { sequence: 1 },
      },
    }), {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: { sequence: 1 },
    });
  });

  it("projects canonical runtime events into hooks and result state", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    /** @type {string[]} */
    const responseOrder = [];
    /** @type {string[]} */
    const responses = [];
    /** @type {Array<{ cost: string, tokens: UsageTokens }>} */
    const usageEvents = [];

    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [{ role: "user", content: [{ type: "text", text: "Ship it" }] }],
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
          responseOrder.push(`reasoning:${event.status}`);
        },
        onLlmResponse: async (text) => {
          responses.push(text);
          responseOrder.push("response");
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
      diagnosticRaw: { type: "message_update" },
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

    assert.deepEqual(reasoningEvents, [
      {
        status: "updated",
        summaryParts: [],
        contentParts: ["Reading files."],
        text: "Reading files.",
      },
      {
        status: "completed",
        summaryParts: [],
        contentParts: ["Reading files."],
        text: "Reading files.",
      },
    ]);
    assert.deepEqual(responseOrder, ["reasoning:updated", "reasoning:completed", "response"]);
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
  });

  it("does not synthesize duplicate reasoning completion after an explicit completion", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [],
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "pi",
      text: "Inspecting.",
      status: "updated",
    });
    await dispatcher.handleEvent({
      type: "reasoning.completed",
      provider: "pi",
      text: "Final reasoning.",
      status: "completed",
      contentParts: ["Final reasoning."],
      summaryParts: [],
    });
    await dispatcher.handleEvent({
      type: "assistant.completed",
      provider: "pi",
      text: "Done.",
      contentType: "markdown",
    });

    assert.deepEqual(reasoningEvents.map((event) => event.status), ["updated", "completed"]);
  });

  it("synthesizes delta reasoning chunks as one completed text", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "Inspect",
      status: "updated",
      contentParts: ["Inspect"],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "ing the request.",
      status: "updated",
      contentParts: ["ing the request."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "assistant.completed",
      provider: "acp",
      text: "Done.",
      contentType: "markdown",
    });

    assert.deepEqual(reasoningEvents.at(-1), {
      status: "completed",
      summaryParts: [],
      contentParts: ["Inspecting the request."],
      text: "Inspecting the request.",
    });
  });

  it("deduplicates ACP reasoning snapshots that repeat earlier delta chunks", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "Thinking...",
      status: "updated",
      contentParts: ["Thinking..."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "**Inspecting user feedback**\n\nI",
      status: "updated",
      contentParts: ["**Inspecting user feedback**\n\nI"],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: " need to inspect logs.",
      status: "updated",
      contentParts: [" need to inspect logs."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "**Inspecting user feedback**\n\nI need to inspect logs.",
      status: "updated",
      contentParts: ["**Inspecting user feedback**\n\nI need to inspect logs."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "assistant.completed",
      provider: "acp",
      text: "Done.",
      contentType: "markdown",
    });

    assert.deepEqual(reasoningEvents.at(-1), {
      status: "completed",
      summaryParts: [],
      contentParts: ["**Inspecting user feedback**\n\nI need to inspect logs."],
      text: "**Inspecting user feedback**\n\nI need to inspect logs.",
    });
  });

  it("does not concatenate separate ACP thinking traces into one completion", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "Thinking...",
      status: "updated",
      contentParts: ["Thinking..."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "**Addressing user requests**\n\nI need to respond.",
      status: "updated",
      contentParts: ["**Addressing user requests**\n\nI need to respond."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "Thinking...",
      status: "updated",
      contentParts: ["Thinking..."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "acp",
      text: "**Updating tests based on user feedback**\n\nI need to remove absence-only tests.",
      status: "updated",
      contentParts: ["**Updating tests based on user feedback**\n\nI need to remove absence-only tests."],
      summaryParts: [],
      appendMode: "delta",
    });
    await dispatcher.handleEvent({
      type: "assistant.completed",
      provider: "acp",
      text: "Done.",
      contentType: "markdown",
    });

    assert.deepEqual(
      reasoningEvents.filter((event) => event.status === "completed"),
      [
        {
          status: "completed",
          summaryParts: [],
          contentParts: ["**Addressing user requests**\n\nI need to respond."],
          text: "**Addressing user requests**\n\nI need to respond.",
        },
        {
          status: "completed",
          summaryParts: [],
          contentParts: ["**Updating tests based on user feedback**\n\nI need to remove absence-only tests."],
          text: "**Updating tests based on user feedback**\n\nI need to remove absence-only tests.",
        },
      ],
    );
  });

  it("preserves context window from earlier usage updates when final usage omits it", async () => {
    /** @type {Array<{ cost: string, tokens: UsageTokens }>} */
    const usageEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks: {
        onUsage: async (cost, tokens) => {
          usageEvents.push({ cost, tokens });
        },
      },
    });

    await dispatcher.handleEvent({
      type: "usage.updated",
      provider: "acp",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0,
        totalTokens: 42,
        contextWindow: 1000,
      },
    });
    await dispatcher.handleEvent({
      type: "usage.updated",
      provider: "acp",
      usage: {
        promptTokens: 30,
        completionTokens: 10,
        cachedTokens: 5,
        cost: 0.002,
        totalTokens: 42,
        reasoningTokens: 2,
      },
    });

    assert.deepEqual(dispatcher.result.usage, {
      promptTokens: 30,
      completionTokens: 10,
      cachedTokens: 5,
      cost: 0.002,
      totalTokens: 42,
      reasoningTokens: 2,
      contextWindow: 1000,
    });
    assert.deepEqual(usageEvents, [{
      cost: "0.002000",
      tokens: {
        prompt: 30,
        completion: 10,
        cached: 5,
        total: 42,
        reasoning: 2,
        contextWindow: 1000,
      },
    }]);
  });

  it("emits generic tool lifecycle events through the runtime sink instead of legacy tool hooks", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const runtimeEvents = [];

    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [],
      workdir: "/repo",
      emitRuntimeEvent: async (event) => {
        runtimeEvents.push(event);
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

    assert.deepEqual(runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.updated",
      "tool.completed",
    ]);
    assert.equal(runtimeEvents[0]?.type === "tool.started" ? runtimeEvents[0].tool.id : undefined, "tool-1");
  });

  it("keeps ACP terminal output updates in fixture capture without emitting them as chat progress", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const runtimeEvents = [];
    /** @type {Array<Record<string, unknown>>} */
    const captureEntries = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      emitRuntimeEvent: async (event) => {
        runtimeEvents.push(event);
      },
      fixtureCapture: {
        capture: (entry) => {
          captureEntries.push(entry);
        },
        waitForIdle: async () => {},
      },
    });

    await dispatcher.handleEvent({
      type: "tool.updated",
      provider: "acp",
      tool: {
        id: "terminal-1",
        name: "execute",
        arguments: { command: "rg noisy logs" },
        output: "noisy log chunk",
        suppressProgress: true,
      },
      diagnosticRaw: {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "terminal-1",
            _meta: {
              terminal_output_delta: {
                data: "noisy log chunk",
                terminal_id: "terminal-1",
              },
            },
          },
        },
      },
    });

    assert.deepEqual(runtimeEvents, []);
    assert.equal(captureEntries.length, 1);
    assert.equal(captureEntries[0]?.seam, "harness.raw-event");
    assert.equal(captureEntries[0]?.event, "tool.updated");
  });

  it("forwards assistant stream chunks semantically and finalizes on item completion", async () => {
    /** @type {Array<{ text: string, metadata?: LlmResponseMetadata }>} */
    const responses = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks: {
        onLlmResponse: async (text, metadata) => {
          responses.push({ text, metadata });
        },
      },
    });

    await dispatcher.handleEvent({
      type: "content.delta",
      provider: "acp",
      itemId: "assistant-1",
      text: "Hel",
      contentType: "markdown",
    });
    await dispatcher.handleEvent({
      type: "content.delta",
      provider: "acp",
      itemId: "assistant-1",
      text: "lo",
      contentType: "markdown",
    });
    assert.deepEqual(responses.map((entry) => [entry.text, entry.metadata?.streamStatus]), [
      ["Hel", "partial"],
      ["lo", "partial"],
    ]);

    await dispatcher.handleEvent({
      type: "item.completed",
      provider: "acp",
      item: {
        id: "assistant-1",
        kind: "assistant",
        text: "Hello",
      },
    });
    assert.equal(responses.at(-1)?.text, "Hello");
    assert.equal(responses.at(-1)?.metadata?.streamStatus, "final");
    assert.deepEqual(dispatcher.result.response, [{ type: "markdown", text: "Hello" }]);
  });

  it("emits flow-tool runtime events without grouped legacy presentation state", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const runtimeEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [],
      emitRuntimeEvent: async (event) => {
        runtimeEvents.push(event);
      },
    });

    await dispatcher.handleEvent({
      type: "tool.started",
      provider: "pi",
      tool: {
        id: "web-1",
        name: "search_query",
        arguments: { q: "ACP protocol" },
      },
    });
    await dispatcher.handleEvent({
      type: "tool.started",
      provider: "pi",
      tool: {
        id: "web-2",
        name: "open",
        arguments: { ref_id: "https://agentclientprotocol.com" },
      },
    });

    assert.deepEqual(runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.started",
    ]);
    assert.deepEqual(runtimeEvents.map((event) => event.type === "tool.started" ? event.tool.id : null), [
      "web-1",
      "web-2",
    ]);
  });

  it("emits command runtime events through the runtime sink", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const runtimeEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "codex",
      messages: [],
      emitRuntimeEvent: async (event) => {
        runtimeEvents.push(event);
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

    assert.deepEqual(runtimeEvents.map((event) => event.type), [
      "command.started",
      "command.completed",
    ]);
    assert.equal(
      runtimeEvents[0]?.type === "command.started" ? runtimeEvents[0].command.command : undefined,
      "pnpm type-check",
    );
  });

  it("passes ACP command and file-change events through the runtime event boundary", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const runtimeEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      workdir: "/repo",
      hooks: {
        onRuntimeEvent: async (event) => {
          runtimeEvents.push(event);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "command.started",
      provider: "acp",
      command: {
        command: "pnpm type-check",
        status: "started",
      },
      diagnosticRaw: { source: "acp.jsonrpc", method: "session/update" },
    });
    await dispatcher.handleEvent({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: "/repo/src/app.js",
        kind: "update",
        source: "snapshot",
        diff: "--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-before\n+after",
      },
      diagnosticRaw: { source: "acp.jsonrpc", method: "session/update" },
    });

    assert.equal(runtimeEvents.length, 2);
    assert.equal(runtimeEvents[0]?.type, "command.started");
    assert.equal("raw" in (runtimeEvents[0] ?? {}), false);
    assert.equal("diagnosticRaw" in (runtimeEvents[0] ?? {}), false);
    assert.equal(runtimeEvents[1]?.type, "file-change.completed");
    assert.equal(runtimeEvents[1]?.type === "file-change.completed" ? runtimeEvents[1].change.cwd : undefined, "/repo");
    assert.equal("raw" in (runtimeEvents[1] ?? {}), false);
    assert.equal("diagnosticRaw" in (runtimeEvents[1] ?? {}), false);
  });

  it("emits ACP progress through the runtime event sink instead of the legacy runtime hook", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const runtimeEvents = [];
    let legacyRuntimeHookCalls = 0;
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      emitRuntimeEvent: async (event) => {
        runtimeEvents.push(event);
      },
      hooks: {
        onRuntimeEvent: async () => {
          legacyRuntimeHookCalls += 1;
        },
      },
    });

    await dispatcher.handleEvent({
      type: "command.started",
      provider: "acp",
      command: {
        command: "pnpm type-check",
        status: "started",
      },
    });

    assert.equal(legacyRuntimeHookCalls, 0);
    assert.equal(runtimeEvents.length, 1);
    assert.equal(runtimeEvents[0]?.type, "command.started");
    assert.equal(runtimeEvents[0]?.provider, "acp");
  });

  it("passes ACP tool events through the runtime event boundary", async () => {
    /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent[]} */
    const runtimeEvents = [];
    /** @type {ToolContentBlock[][]} */
    const toolResults = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "acp",
      messages: [],
      hooks: {
        onRuntimeEvent: async (event) => {
          runtimeEvents.push(event);
        },
        onToolResult: async (blocks) => {
          toolResults.push(blocks);
        },
      },
    });

    await dispatcher.handleEvent({
      type: "tool.started",
      provider: "acp",
      tool: {
        id: "tool-1",
        name: "Task",
        arguments: { title: "Review mock code" },
      },
    });
    await dispatcher.handleEvent({
      type: "tool.completed",
      provider: "acp",
      tool: {
        id: "tool-1",
        name: "Task",
        arguments: { title: "Review mock code" },
        output: "done",
        outputBlocks: [{ type: "text", text: "tool output" }],
      },
    });

    assert.deepEqual(runtimeEvents.map((event) => event.type), [
      "tool.started",
      "tool.completed",
    ]);
    assert.deepEqual(toolResults, [[{ type: "text", text: "tool output" }]]);
  });

  it("captures raw provider events through fixture capture without changing hook projection", async () => {
    /** @type {string[]} */
    const responses = [];
    /** @type {Array<Record<string, unknown>>} */
    const captureEntries = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "codex",
      messages: [],
      fixtureCapture: {
        capture: (entry) => {
          captureEntries.push(structuredClone(entry));
        },
        waitForIdle: async () => {},
      },
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
      diagnosticRaw: { msg: { type: "agent_message_delta", delta: "Done." } },
    });

    assert.equal(captureEntries.length, 1);
    assert.equal(captureEntries[0].seam, "harness.raw-event");
    assert.equal(captureEntries[0].event, "assistant.completed");
    assert.deepEqual(/** @type {{ payload?: { raw?: unknown } }} */ (captureEntries[0]).payload?.raw, {
        source: "unknown",
        payload: { msg: { type: "agent_message_delta", delta: "Done." } },
    });
    assert.deepEqual(responses, ["Done."]);
  });

  it("accepts session, turn, request, user-input, and file-change runtime events", async () => {
    /** @type {string[]} */
    const runtimeEvents = [];
    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "codex",
      messages: [],
      emitRuntimeEvent: async (event) => {
        runtimeEvents.push(event.type);
      },
      hooks: {
        onRuntimeEvent: async (event) => {
          runtimeEvents.push(`legacy:${event.type}`);
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
    await dispatcher.handleEvent({
      type: "extension.notification",
      provider: "codex",
      method: "madabot/example",
      payload: { ok: true },
    });
    await dispatcher.handleEvent({
      type: "runtime.warning",
      provider: "codex",
      message: "provider reported a warning",
    });

    assert.deepEqual(runtimeEvents, [
      "session.started",
      "turn.started",
      "request.opened",
      "user-input.requested",
      "file-change.completed",
      "turn.completed",
      "extension.notification",
      "runtime.warning",
    ]);
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
