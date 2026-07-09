import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_AUTO_PRESENTED_SNAPSHOT_FILE_CHANGES, buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { buildToolPresentation } from "../whatsapp/tool-presentation-model.js";

/** @type {import("../chat-output-visibility.js").OutputVisibility} */
const VISIBLE_TOOL_OUTPUT = {
  ...DEFAULT_OUTPUT_VISIBILITY,
  tools: "fullDetails",
};

/**
 * @param {import("../chat-output-visibility.js").OutputVisibility} [visibility]
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 * }}
 */
function createSubject(visibility = DEFAULT_OUTPUT_VISIBILITY) {
  /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
  const sent = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (event) => {
        sent.push({ event, kind: "send" });
        return undefined;
      },
      reply: async (event) => {
        sent.push({ event, kind: "reply" });
        return undefined;
      },
      select: async () => "",
      confirm: async () => true,
    },
    null,
    visibility,
  );
  return { hooks, sent };
}

/**
 * @param {() => import("../chat-output-visibility.js").OutputVisibility | Promise<import("../chat-output-visibility.js").OutputVisibility>} getVisibility
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 * }}
 */
function createSubjectWithVisibilityProvider(getVisibility) {
  /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
  const sent = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (event) => {
        sent.push({ event, kind: "send" });
        return undefined;
      },
      reply: async (event) => {
        sent.push({ event, kind: "reply" });
        return undefined;
      },
      select: async () => "",
      confirm: async () => true,
    },
    null,
    getVisibility,
  );
  return { hooks, sent };
}

/**
 * @param {string | null} cwd
 * @param {import("../chat-output-visibility.js").OutputVisibility} [visibility]
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 * }}
 */
function createSubjectWithCwd(cwd, visibility = DEFAULT_OUTPUT_VISIBILITY) {
  /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
  const sent = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (event) => {
        sent.push({ event, kind: "send" });
        return undefined;
      },
      reply: async (event) => {
        sent.push({ event, kind: "reply" });
        return undefined;
      },
      select: async () => "",
      confirm: async () => true,
    },
    cwd,
    visibility,
  );
  return { hooks, sent };
}

/**
 * @param {import("../chat-output-visibility.js").OutputVisibility} [visibility]
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 *   reasoningUpdates: MessageHandleUpdate[],
 *   reasoningInspects: MessageInspectState[],
 * }}
 */
function createReasoningSubject(visibility = DEFAULT_OUTPUT_VISIBILITY) {
  /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
  const sent = [];
  /** @type {MessageHandleUpdate[]} */
  const reasoningUpdates = [];
  /** @type {MessageInspectState[]} */
  const reasoningInspects = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (event) => {
        sent.push({ event, kind: "send" });
        return undefined;
      },
      reply: async (event) => {
        sent.push({ event, kind: "reply" });
        return {
          transportHandleId: "reasoning-msg-1",
          update: async (update) => {
            reasoningUpdates.push(structuredClone(update));
          },
          setInspect: (inspect) => {
            if (inspect) {
              reasoningInspects.push(structuredClone(inspect));
            }
          },
        };
      },
      select: async () => "",
      confirm: async () => true,
    },
    null,
    visibility,
  );
  return { hooks, sent, reasoningUpdates, reasoningInspects };
}

/**
 * @param {() => import("../chat-output-visibility.js").OutputVisibility | Promise<import("../chat-output-visibility.js").OutputVisibility>} getVisibility
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 *   reasoningUpdates: MessageHandleUpdate[],
 *   reasoningInspects: MessageInspectState[],
 * }}
 */
function createReasoningSubjectWithVisibilityProvider(getVisibility) {
  /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
  const sent = [];
  /** @type {MessageHandleUpdate[]} */
  const reasoningUpdates = [];
  /** @type {MessageInspectState[]} */
  const reasoningInspects = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (event) => {
        sent.push({ event, kind: "send" });
        return undefined;
      },
      reply: async (event) => {
        sent.push({ event, kind: "reply" });
        return {
          transportHandleId: "reasoning-msg-1",
          update: async (update) => {
            reasoningUpdates.push(structuredClone(update));
          },
          setInspect: (inspect) => {
            if (inspect) {
              reasoningInspects.push(structuredClone(inspect));
            }
          },
        };
      },
      select: async () => "",
      confirm: async () => true,
    },
    null,
    getVisibility,
  );
  return { hooks, sent, reasoningUpdates, reasoningInspects };
}

/**
 * @param {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} sent
 * @param {"send" | "reply"} messageKind
 * @param {OutboundEvent["kind"]} eventKind
 */
function assertSingleSentEvent(sent, messageKind, eventKind) {
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, messageKind);
  assert.equal(sent[0]?.event.kind, eventKind);
}

/**
 * @param {ToolPresentation | null} presentation
 * @returns {import("../plan-presentation.js").PlanPresentation}
 */
function requirePlanPresentation(presentation) {
  assert.equal(presentation?.kind, "plan");
  return /** @type {import("../plan-presentation.js").PlanPresentation} */ (presentation);
}

/**
 * @param {AgentIOHooks} hooks
 * @param {string} command
 * @param {"started" | "completed" | "failed"} status
 * @param {string} [output]
 * @returns {Promise<void>}
 */
async function emitRuntimeCommand(hooks, command, status, output) {
  await hooks.onRuntimeEvent?.({
    type: `command.${status}`,
    provider: "codex",
    command: {
      command,
      status,
      ...(output !== undefined && { output }),
    },
  });
}

describe("buildAgentIoHooks", () => {
  it("forwards generic runtime events as semantic outbound events", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);

    const notification = /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent} */ ({
      type: "extension.notification",
      provider: "acp",
      method: "madabot/example",
      payload: { ok: true },
    });
    const warning = /** @type {import("../harnesses/harness-runtime-events.js").HarnessRuntimeEvent} */ ({
      type: "runtime.warning",
      provider: "acp",
      message: "provider warning",
    });

    await hooks.onRuntimeEvent?.(notification);
    await hooks.onRuntimeEvent?.(warning);

    assert.deepEqual(sent, [
      {
        kind: "send",
        event: {
          kind: "runtime_event",
          event: notification,
        },
      },
      {
        kind: "send",
        event: {
          kind: "runtime_event",
          event: warning,
        },
      },
    ]);
  });

  it("does not format generic runtime events before the transport", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);

    await hooks.onRuntimeEvent?.({
      type: "extension.notification",
      provider: "acp",
      method: "madabot/example",
      payload: { ok: true },
    });
    await hooks.onRuntimeEvent?.({
      type: "runtime.warning",
      provider: "acp",
      message: "provider warning",
    });

    assert.equal(sent.every((entry) => entry.event.kind === "runtime_event"), true);
  });

  it("emits canonical runtime outbound events without diagnostic payloads", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);

    await hooks.onRuntimeEvent?.({
      type: "tool.started",
      provider: "acp",
      tool: {
        id: "read-1",
        name: "Read",
        arguments: { file_path: "/repo/src/app.js" },
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.event.kind, "runtime_event");
    if (sent[0]?.event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal("raw" in sent[0].event.event, false);
    assert.deepEqual(sent[0].event.event, {
      type: "tool.started",
      provider: "acp",
      tool: {
        id: "read-1",
        name: "Read",
        arguments: { file_path: "/repo/src/app.js" },
      },
    });
  });

  it("maps plan events to an llm reply", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onPlan?.(requirePlanPresentation(buildToolPresentation("update_plan", {
      explanation: "Keep the user informed.",
      plan: [
        { step: "Patch the formatter", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    }, undefined, undefined, undefined)));

    assertSingleSentEvent(sent, "reply", "plan");
    if (sent[0].event.kind !== "plan") {
      assert.fail("Expected plan event");
    }
    assert.equal(sent[0].event.presentation.summary, "*Plan*  _Working on: Patch the formatter_");
  });

  it("maps sub-agent llm responses to subagent_message events", async () => {
    const { hooks, sent } = createSubject();

    await hooks.onLlmResponse?.("SUBAGENT_VISIBLE_TEST: hello from the spawned sub-agent.", {
      source: "subagent",
      threadId: "thread-child",
      parentThreadId: "thread-parent",
      agentNickname: "Mill",
      agentRole: "worker",
    });

    assertSingleSentEvent(sent, "reply", "subagent_message");
    assert.deepEqual(sent[0]?.event, {
      kind: "subagent_message",
      text: "SUBAGENT_VISIBLE_TEST: hello from the spawned sub-agent.",
      threadId: "thread-child",
      parentThreadId: "thread-parent",
      agentNickname: "Mill",
      agentRole: "worker",
    });
  });

  it("suppresses sub-agent llm responses when sub-agent visibility is off", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, subagents: "hidden" });

    await hooks.onLlmResponse?.("Hidden sub-agent update", {
      source: "subagent",
      threadId: "thread-child",
      agentNickname: "Mill",
    });

    assert.equal(sent.length, 0);
  });

  it("does not send partial assistant stream chunks", async () => {
    /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
    const sent = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => {
          sent.push({ event, kind: "send" });
          return {
            transportHandleId: "runtime-command-stream",
            update: async () => {},
            setInspect: () => {},
          };
        },
        reply: async (event) => {
          sent.push({ event, kind: "reply" });
          return undefined;
        },
        select: async () => "",
        confirm: async () => true,
      },
      "/repo",
      { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" },
    );

    await emitRuntimeCommand(hooks, "pnpm test", "started");
    await hooks.onLlmResponse?.("async-gap fix", {
      source: "llm",
      streamId: "assistant-1",
      streamStatus: "partial",
    });
    await emitRuntimeCommand(hooks, "pnpm test", "completed", "ok");
    await hooks.onLlmResponse?.("async-gap fix complete", {
      source: "llm",
      streamId: "assistant-1",
      streamStatus: "final",
    });

    assert.deepEqual(sent.map((entry) => entry.kind), ["send", "send", "reply"]);
    assert.deepEqual(sent.map((entry) => entry.event.kind), [
      "runtime_event",
      "runtime_event",
      "assistant_output",
    ]);
    assert.equal(sent[0]?.event.kind === "runtime_event" ? sent[0].event.event.type : "", "command.started");
    assert.equal(sent[1]?.event.kind === "runtime_event" ? sent[1].event.event.type : "", "command.completed");
    assert.equal(sent[2]?.event.kind, "assistant_output");
  });

  it("sends one thinking placeholder and makes it inspectable", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({ status: "started", summaryParts: [], contentParts: [] });
    await subject.hooks.onReasoning?.({
      status: "completed",
      itemId: "reason-1",
      summaryParts: [],
      contentParts: ["Inspect the file, then patch the bug."],
      text: "Inspect the file, then patch the bug.",
    });

    assert.equal(subject.sent.length, 1);
    assert.equal(subject.sent[0].kind, "reply");
    assert.equal(subject.sent[0].event.kind, "assistant_output");
    if (subject.sent[0].event.kind !== "assistant_output") {
      assert.fail("Expected assistant_output event");
    }
    assert.deepEqual(subject.sent[0].event.content, [{ type: "text", text: "Thinking..." }]);
    assert.deepEqual(subject.reasoningUpdates, [{ kind: "text", text: "Thought" }]);
    assert.equal(subject.reasoningInspects.length, 1);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thought*",
      text: "Inspect the file, then patch the bug.",
    });
  });

  it("does not attach inspect data until reasoning completes", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: ["summary token"],
      contentParts: ["raw chain token"],
    });
    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: ["second trace token"],
    });
    assert.deepEqual(subject.reasoningInspects, []);

    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: ["final summary"],
      contentParts: [],
    });

    assert.equal(subject.reasoningInspects.length, 1);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thought*",
      text: "final summary",
    });

    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: ["late duplicate"],
      contentParts: [],
    });
    assert.equal(subject.reasoningInspects.length, 1);
  });

  it("does not mark reasoning as Thought before inspect data exists", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: [],
      text: "",
    });

    assert.deepEqual(subject.reasoningUpdates, []);
    assert.deepEqual(subject.reasoningInspects, []);

    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: ["Inspectable reasoning."],
      text: "Inspectable reasoning.",
    });

    assert.deepEqual(subject.reasoningUpdates, [{ kind: "text", text: "Thought" }]);
    assert.deepEqual(subject.reasoningInspects, [{
      kind: "reasoning",
      summary: "*Thought*",
      text: "Inspectable reasoning.",
    }]);
  });

  it("does not duplicate reasoning text repeated by a synthetic completion", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: ["Inspecting the request."],
      text: "Inspecting the request.",
    });
    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: ["Inspecting the request."],
      text: "Inspecting the request.",
    });

    assert.equal(subject.reasoningInspects.length, 1);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thought*",
      text: "Inspecting the request.",
    });
  });

  it("starts a new thinking message for a new reasoning trace after finalization", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: ["First trace."],
      text: "First trace.",
    });
    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: ["First trace."],
      text: "First trace.",
    });
    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: ["Second trace."],
      text: "Second trace.",
    });
    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: ["Second trace."],
      text: "Second trace.",
    });

    assert.equal(subject.sent.length, 2);
    assert.deepEqual(subject.reasoningUpdates, [
      { kind: "text", text: "Thought" },
      { kind: "text", text: "Thought" },
    ]);
    assert.deepEqual(subject.reasoningInspects, [
      {
        kind: "reasoning",
        summary: "*Thought*",
        text: "First trace.",
      },
      {
        kind: "reasoning",
        summary: "*Thought*",
        text: "Second trace.",
      },
    ]);
  });

  it("drops token fragments when a later reasoning completion contains the full text", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: ["I", "need", "to", "inspect", "the", "bug."],
    });
    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: [],
      text: "I need to inspect the bug.",
    });

    assert.equal(subject.reasoningInspects.length, 1);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thought*",
      text: "I need to inspect the bug.",
    });
  });

  it("attaches only completed reasoning text instead of streamed chunks", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: [".", ",", "I", "need", "to", "inspect"],
    });
    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: ["I need to inspect the bug."],
      text: "I need to inspect the bug.",
    });

    assert.equal(subject.reasoningInspects.length, 1);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thought*",
      text: "I need to inspect the bug.",
    });
  });

  it("reports encrypted reasoning once it completes without exposing content", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: [],
      hasEncryptedContent: true,
    });
    assert.deepEqual(subject.reasoningInspects, []);

    await subject.hooks.onReasoning?.({
      status: "completed",
      summaryParts: [],
      contentParts: [],
      hasEncryptedContent: true,
    });

    assert.equal(subject.reasoningInspects.length, 1);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thought*",
      text: "_Reasoning is encrypted and not available for display._",
    });
  });

  it("suppresses thinking output when visibility disables it", async () => {
    const subject = createReasoningSubject({ ...DEFAULT_OUTPUT_VISIBILITY, reasoning: "hidden" });

    await subject.hooks.onReasoning?.({
      status: "completed",
      itemId: "reason-hidden-1",
      summaryParts: [],
      contentParts: ["This should stay hidden."],
      text: "This should stay hidden.",
    });

    assert.equal(subject.sent.length, 0);
    assert.deepEqual(subject.reasoningUpdates, []);
    assert.deepEqual(subject.reasoningInspects, []);
  });

  it("keeps active reasoning item visibility through completion while later items sample live settings", async () => {
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    let visibility = { ...DEFAULT_OUTPUT_VISIBILITY, reasoning: "indicatorInspectable" };
    const subject = createReasoningSubjectWithVisibilityProvider(() => visibility);

    await subject.hooks.onReasoning?.({
      status: "updated",
      itemId: "reason-live-1",
      summaryParts: [],
      contentParts: ["Visible item started."],
      text: "Visible item started.",
    });
    visibility = { ...DEFAULT_OUTPUT_VISIBILITY, reasoning: "hidden" };
    await subject.hooks.onReasoning?.({
      status: "completed",
      itemId: "reason-live-1",
      summaryParts: [],
      contentParts: ["Visible item completed."],
      text: "Visible item completed.",
    });
    await subject.hooks.onReasoning?.({
      status: "updated",
      itemId: "reason-live-2",
      summaryParts: [],
      contentParts: ["Hidden item started."],
      text: "Hidden item started.",
    });

    assert.equal(subject.sent.length, 1);
    assert.equal(subject.sent[0]?.event.kind, "assistant_output");
    assert.equal(subject.reasoningUpdates.length, 1);
    assert.equal(subject.reasoningInspects.length, 1);
    assert.equal(subject.reasoningInspects[0]?.kind, "reasoning");
    if (subject.reasoningInspects[0]?.kind !== "reasoning") {
      assert.fail("Expected reasoning inspect state");
    }
    assert.equal(subject.reasoningInspects[0].text, "Visible item completed.");
  });

  it("emits reasoning as a pinned runtime indicator when configured", async () => {
    const subject = createReasoningSubject({ ...DEFAULT_OUTPUT_VISIBILITY, reasoning: "pinnedIndicator" });

    await subject.hooks.onReasoning?.({
      status: "updated",
      itemId: "reason-pinned-1",
      summaryParts: [],
      contentParts: ["Working"],
      text: "Working",
    });

    assert.deepEqual(subject.reasoningUpdates, []);
    assert.deepEqual(subject.reasoningInspects, []);
    assert.equal(subject.sent.length, 1);
    assert.equal(subject.sent[0]?.event.kind, "runtime_event");
    if (subject.sent[0]?.event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(subject.sent[0].event.event.type, "reasoning.updated");
  });

  it("emits completed reasoning as a full detail message when configured", async () => {
    const subject = createReasoningSubject({ ...DEFAULT_OUTPUT_VISIBILITY, reasoning: "fullDetails" });

    await subject.hooks.onReasoning?.({
      status: "completed",
      itemId: "reason-full-1",
      summaryParts: [],
      contentParts: ["Detailed trace."],
      text: "Detailed trace.",
    });

    assert.deepEqual(subject.reasoningUpdates, []);
    assert.deepEqual(subject.reasoningInspects, []);
    assert.equal(subject.sent.length, 1);
    assert.equal(subject.sent[0]?.event.kind, "assistant_output");
    if (subject.sent[0]?.event.kind !== "assistant_output") {
      assert.fail("Expected assistant_output");
    }
    assert.deepEqual(subject.sent[0].event.content, [{
      type: "markdown",
      text: "*Thought*\n\nDetailed trace.",
    }]);
  });

  it("suppresses middle assistant messages when configured", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, middleAssistantMessages: "off" });

    await hooks.onLlmResponse?.("Intermediate answer", {
      source: "llm",
      streamId: "assistant-item-1",
      streamStatus: "final",
    });
    await hooks.onLlmResponse?.("Final answer");

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["assistant_output"]);
    if (sent[0]?.event.kind !== "assistant_output" || !Array.isArray(sent[0].event.content)) {
      assert.fail("Expected assistant_output array content");
    }
    const block = sent[0].event.content[0];
    if (!block || (block.type !== "text" && block.type !== "markdown")) {
      assert.fail("Expected text assistant output block");
    }
    assert.equal(block.text, "Final answer");
  });

  it("emits command starts as runtime events", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);
    await emitRuntimeCommand(hooks, "npm test", "started");

    assertSingleSentEvent(sent, "send", "runtime_event");
    if (sent[0].event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(sent[0].event.event.type, "command.started");
    assert.equal(sent[0].event.event.provider, "codex");
    assert.deepEqual(sent[0].event.event.command, {
      command: "npm test",
      status: "started",
    });
  });

  it("passes command runtime events without transport presentation flags", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });

    await emitRuntimeCommand(hooks, "pnpm type-check", "started");

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event"]);
    assert.equal(sent[0]?.event.kind === "runtime_event" ? sent[0].event.event.type : "", "command.started");
    assert.equal("compact" in sent[0].event, false);
  });

  it("suppresses no-op ACP editing-files placeholder tool calls", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });

    const toolCall = { id: "acp-editing-files", name: "Editing files", arguments: "{}" };
    await hooks.onToolCall?.(toolCall);
    await hooks.onToolComplete?.(toolCall);

    assert.deepEqual(sent, []);
  });

  it("emits direct tool lifecycle as runtime outbound events", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });
    const toolCall = {
      id: "tool-complete-1",
      name: "spawn_agent",
      arguments: JSON.stringify({ message: "hello" }),
    };
    await hooks.onToolCall?.(toolCall);
    await hooks.onToolComplete?.(toolCall);

    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.event.kind, "runtime_event");
    assert.deepEqual(sent[0]?.event, {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.started",
        provider: "codex",
        tool: {
          id: "tool-complete-1",
          name: "spawn_agent",
          arguments: { message: "hello" },
        },
      },
    });
    assert.deepEqual(sent[1]?.event, {
      kind: "runtime_event",
      cwd: "/repo",
      event: {
        type: "tool.completed",
        provider: "codex",
        tool: {
          id: "tool-complete-1",
          name: "spawn_agent",
          arguments: { message: "hello" },
        },
      },
    });
  });

  it("samples live visibility for new tool items without changing active tool completion", async () => {
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    let visibility = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" };
    const { hooks, sent } = createSubjectWithVisibilityProvider(() => visibility);
    const firstTool = {
      id: "live-tool-1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "/repo/a.js" }),
    };
    const secondTool = {
      id: "live-tool-2",
      name: "Read",
      arguments: JSON.stringify({ file_path: "/repo/b.js" }),
    };

    await hooks.onToolCall?.(firstTool);
    visibility = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "hidden" };
    await hooks.onToolComplete?.(firstTool);
    await hooks.onToolCall?.(secondTool);
    await hooks.onToolComplete?.(secondTool);

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event", "runtime_event"]);
    assert.deepEqual(sent.map((entry) => entry.event.kind === "runtime_event" ? entry.event.event.type : ""), [
      "tool.started",
      "tool.completed",
    ]);
  });

  it("keeps active tool result visibility through completion while later tool results sample live settings", async () => {
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    let visibility = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" };
    const { hooks, sent } = createSubjectWithVisibilityProvider(() => visibility);
    const compactTool = {
      id: "live-tool-result-1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "/repo/a.js" }),
    };
    const fullDetailTool = {
      id: "live-tool-result-2",
      name: "Read",
      arguments: JSON.stringify({ file_path: "/repo/b.js" }),
    };

    await hooks.onToolCall?.(compactTool);
    visibility = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "fullDetails" };
    await hooks.onToolResult?.([{ type: "text", text: "compact-start result" }], "Read", {});
    await hooks.onToolComplete?.(compactTool);
    await hooks.onToolCall?.(fullDetailTool);
    visibility = { ...DEFAULT_OUTPUT_VISIBILITY, tools: "hidden" };
    await hooks.onToolResult?.([{ type: "text", text: "full-detail-start result" }], "Read", {});
    await hooks.onToolComplete?.(fullDetailTool);

    assert.deepEqual(sent.map((entry) => entry.event.kind), [
      "runtime_event",
      "runtime_event",
      "tool_call",
      "agent_tool_result",
    ]);
  });

  it("passes unrecognized tool actions through runtime output events", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });
    const toolCall = {
      id: "mass-rename-1",
      name: "mass_rename",
      arguments: JSON.stringify({
        replacements: [{ from: "old-name", to: "new-name" }],
        dry_run: false,
      }),
    };

    await hooks.onToolCall?.(toolCall);
    await hooks.onToolComplete?.(toolCall);

    assert.deepEqual(sent.map((entry) => entry.event), [
      {
        kind: "runtime_event",
        cwd: "/repo",
        event: {
          type: "tool.started",
          provider: "codex",
          tool: {
            id: "mass-rename-1",
            name: "mass_rename",
            arguments: {
              replacements: [{ from: "old-name", to: "new-name" }],
              dry_run: false,
            },
          },
        },
      },
      {
        kind: "runtime_event",
        cwd: "/repo",
        event: {
          type: "tool.completed",
          provider: "codex",
          tool: {
            id: "mass-rename-1",
            name: "mass_rename",
            arguments: {
              replacements: [{ from: "old-name", to: "new-name" }],
              dry_run: false,
            },
          },
        },
      },
    ]);
  });

  it("renders edit diffs even when generic tool progress is hidden", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", {
      ...DEFAULT_OUTPUT_VISIBILITY,
      tools: "indicatorInspectable",
      fileChanges: "shown",
    });

    await hooks.onToolCall?.({
      id: "edit-1",
      name: "Edit",
      arguments: JSON.stringify({
        file_path: "/repo/package.json",
        old_string: "\"version\": \"1.0.0\"",
        new_string: "\"version\": \"1.0.1\"",
      }),
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.event.kind, "tool_call");
    if (sent[0]?.event.kind !== "tool_call") {
      assert.fail("Expected edit tool call to bypass runtime tool progress");
    }
    assert.deepEqual(sent[0].event.toolCall, {
      id: "edit-1",
      name: "Edit",
      arguments: JSON.stringify({
        file_path: "/repo/package.json",
        old_string: "\"version\": \"1.0.0\"",
        new_string: "\"version\": \"1.0.1\"",
      }),
    });
    assert.equal(sent[0].event.cwd, "/repo");
  });

  it("passes command failures as runtime outbound events instead of sending a separate error message", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });

    await emitRuntimeCommand(hooks, "pnpm test", "started");
    await emitRuntimeCommand(hooks, "pnpm test", "failed", "boom");

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event", "runtime_event"]);
    assert.equal(sent[1]?.event.kind === "runtime_event" ? sent[1].event.event.type : "", "command.failed");
  });

  it("passes runtime progress without inserting transport close events", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });
    await emitRuntimeCommand(hooks, "pwd", "started");
    await emitRuntimeCommand(hooks, "pnpm type-check", "started");
    await hooks.onLlmResponse?.("Done");
    await emitRuntimeCommand(hooks, "git diff", "started");

    await emitRuntimeCommand(hooks, "pwd", "started");
    await emitRuntimeCommand(hooks, "git diff", "started");
    await hooks.onFileChange?.({ path: "/repo/src/app.js", summary: "Updated file" });
    await emitRuntimeCommand(hooks, "ls", "started");

    assert.deepEqual(sent.map((entry) => entry.event.kind), [
      "runtime_event",
      "runtime_event",
      "assistant_output",
      "runtime_event",
      "runtime_event",
      "runtime_event",
      "runtime_event",
      "runtime_event",
    ]);
  });

  it("keeps runtime progress and non-tool events separate without transport grouping", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });

    await emitRuntimeCommand(hooks, "pwd", "started");
    await hooks.onPlan?.(requirePlanPresentation(buildToolPresentation("update_plan", {
      plan: [{ step: "Inspect output", status: "in_progress" }],
    }, undefined, undefined, undefined)));
    await emitRuntimeCommand(hooks, "pnpm test", "started");
    await hooks.onUsage?.("0.000000", { prompt: 1, completion: 1, cached: 0 });
    await emitRuntimeCommand(hooks, "git diff", "started");
    await hooks.onRuntimeEvent?.({
      type: "runtime.warning",
      provider: "acp",
      message: "provider warning",
    });
    await emitRuntimeCommand(hooks, "ls", "started");

    assert.deepEqual(sent.map((entry) => entry.event.kind), [
      "runtime_event",
      "plan",
      "runtime_event",
      "usage",
      "runtime_event",
      "runtime_event",
      "runtime_event",
    ]);
  });

  it("suppresses tool result progress events when visibility disables full tool details", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, tools: "indicatorInspectable" });

    await hooks.onToolResult?.([{ type: "text", text: "Intermediate tool output" }], "tool", {});

    assert.equal(sent.length, 0);
  });

  it("suppresses all tool presentation when tools are hidden", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, tools: "hidden" });
    const toolCall = {
      id: "hidden-tool-1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "/repo/file.js" }),
    };

    await hooks.onToolCall?.(toolCall);
    await hooks.onToolComplete?.(toolCall);
    await hooks.onToolResult?.([{ type: "text", text: "output" }], "Read", {});
    await hooks.onToolError?.("tool failed");

    assert.deepEqual(sent, []);
  });

  it("suppresses file change progress when visibility disables changes", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, fileChanges: "hidden" });

    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assert.equal(sent.length, 0);
  });

  it("samples live visibility for file changes emitted after a settings change", async () => {
    /** @type {import("../chat-output-visibility.js").OutputVisibility} */
    let visibility = { ...DEFAULT_OUTPUT_VISIBILITY, fileChanges: "shown" };
    const { hooks, sent } = createSubjectWithVisibilityProvider(() => visibility);

    await hooks.onFileChange?.({ path: "/tmp/visible.js", summary: "Visible change" });
    visibility = { ...DEFAULT_OUTPUT_VISIBILITY, fileChanges: "hidden" };
    await hooks.onFileChange?.({ path: "/tmp/hidden.js", summary: "Hidden change" });

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event"]);
    if (sent[0]?.event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(sent[0].event.event.type, "file-change.completed");
    assert.equal(sent[0].event.event.change.path, "/tmp/visible.js");
  });

  it("suppresses snapshot file changes when snapshots are off", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, snapshots: "off" });

    await hooks.onRuntimeEvent?.({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: "/tmp/snapshot.js",
        source: "snapshot",
        kind: "update",
      },
    });

    assert.deepEqual(sent, []);
  });

  it("suppresses plans and usage when their categories are hidden", async () => {
    const { hooks, sent } = createSubject({
      ...DEFAULT_OUTPUT_VISIBILITY,
      plans: "hidden",
      usage: "hidden",
    });

    await hooks.onPlan?.(requirePlanPresentation(buildToolPresentation("update_plan", {
      plan: [{ step: "Inspect output", status: "in_progress" }],
    }, undefined, undefined, undefined)));
    await hooks.onUsage?.("0.000000", { prompt: 1, completion: 1, cached: 0 });

    assert.deepEqual(sent, []);
  });

  it("passes command text to WhatsApp without Shell presentation", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", VISIBLE_TOOL_OUTPUT);
    await emitRuntimeCommand(hooks, "rg -n \"needle\" src", "started");

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event.kind, "runtime_event");
    if (sent[0].event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(sent[0].event.event.type, "command.started");
    assert.equal(sent[0].event.event.command.command, "rg -n \"needle\" src");
  });

  it("emits command completion through the runtime boundary", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);
    await emitRuntimeCommand(hooks, "pwd", "started");
    await emitRuntimeCommand(hooks, "pwd", "completed", "/repo\n");

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event", "runtime_event"]);
    assert.equal(sent[1]?.event.kind === "runtime_event" ? sent[1].event.event.type : "", "command.completed");
    assert.equal(sent[1]?.event.kind === "runtime_event" && "command" in sent[1].event.event ? sent[1].event.event.command.output : "", "/repo\n");
  });

  it("emits command failures through the runtime boundary", async () => {
    /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
    const sent = [];
    /** @type {MessageHandleUpdate[]} */
    const updates = [];
    /** @type {MessageInspectState[]} */
    const inspects = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => {
          sent.push({ event, kind: "send" });
          return {
            transportHandleId: "visible-command-failure",
            update: async (update) => { updates.push(structuredClone(update)); },
            setInspect: (inspect) => {
              if (inspect) {
                inspects.push(structuredClone(inspect));
              }
            },
          };
        },
        reply: async () => undefined,
        select: async () => "",
        confirm: async () => true,
      },
      "/repo",
      VISIBLE_TOOL_OUTPUT,
    );

    await emitRuntimeCommand(hooks, "pnpm test", "started");
    await emitRuntimeCommand(hooks, "pnpm test", "failed", "boom");

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event", "runtime_event"]);
    assert.equal(sent[1]?.event.kind === "runtime_event" ? sent[1].event.event.type : "", "command.failed");
    if (sent[1]?.event.kind !== "runtime_event" || !("command" in sent[1].event.event)) {
      assert.fail("Expected command runtime event");
    }
    assert.deepEqual(sent[1].event.event.command, {
      command: "pnpm test",
      status: "failed",
      output: "boom",
    });
    assert.deepEqual(updates, []);
    assert.deepEqual(inspects, []);
  });

  it("emits file changes as runtime events", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assertSingleSentEvent(sent, "send", "runtime_event");
    if (sent[0].event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(sent[0].event.event.type, "file-change.completed");
    assert.equal(sent[0].event.event.provider, "codex");
    assert.equal(sent[0].event.event.change.path, "/tmp/file.js");
    assert.equal(sent[0].event.event.change.summary, "Updated file");
  });

  it("passes file change diff facts through the runtime boundary", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileChange?.({
      path: "/tmp/file.js",
      summary: "Updated file",
      oldText: "const value = 1;\n",
      newText: "const value = 2;\n",
      diff: ["--- a/file.js", "+++ b/file.js", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
    });

    assertSingleSentEvent(sent, "send", "runtime_event");
    if (sent[0].event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(sent[0].event.event.type, "file-change.completed");
    assert.equal(sent[0].event.event.change.path, "/tmp/file.js");
    assert.equal(sent[0].event.event.change.oldText, "const value = 1;\n");
    assert.equal(sent[0].event.event.change.newText, "const value = 2;\n");
    assert.equal(sent[0].event.event.change.diff, ["--- a/file.js", "+++ b/file.js", "@@ -1 +1 @@", "-old", "+new"].join("\n"));
  });

  it("leaves file change path and summary presentation to WhatsApp", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo");
    await hooks.onFileChange?.({
      path: "/repo/src/file.js",
      summary: "/repo/src/file.js (add)",
      kind: "add",
      oldText: "",
      newText: "export const value = 1;\n",
      diff: ["--- /dev/null", "+++ b/src/file.js", "@@ -0,0 +1,1 @@", "+export const value = 1;"].join("\n"),
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event.kind, "runtime_event");
    if (sent[0].event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(sent[0].event.event.type, "file-change.completed");
    assert.equal(sent[0].event.event.change.path, "/repo/src/file.js");
    assert.equal(sent[0].event.event.change.kind, "add");
    assert.equal(sent[0].event.event.change.summary, "/repo/src/file.js (add)");
    assert.equal(sent[0].event.event.change.cwd, "/repo");
  });

  it("asks in the WhatsApp hook before presenting large snapshot file-change batches", async () => {
    /** @type {Array<{ question: string, options: SelectOption[] }>} */
    const prompts = [];
    /** @type {Array<OutboundEvent>} */
    const sent = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => {
          sent.push(event);
          return undefined;
        },
        reply: async () => undefined,
        select: async (question, options) => {
          prompts.push({ question, options });
          return "❌ Skip";
        },
        confirm: async () => true,
      },
      "/repo",
      DEFAULT_OUTPUT_VISIBILITY,
    );
    const events = Array.from({ length: MAX_AUTO_PRESENTED_SNAPSHOT_FILE_CHANGES + 1 }, (_entry, index) => ({
      type: /** @type {const} */ ("file-change.completed"),
      provider: "acp",
      change: {
        path: `/repo/generated-${index}.txt`,
        kind: /** @type {const} */ ("add"),
        source: /** @type {const} */ ("snapshot"),
        newText: `generated ${index}\n`,
      },
    }));

    for (const event of events) {
      await hooks.onRuntimeEvent?.(event);
    }
    await hooks.onRuntimeEvent?.({
      type: "runtime.warning",
      provider: "acp",
      message: "after snapshot batch",
    });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0]?.question ?? "", /Snapshot detected \*26\* unreported file changes/);
    assert.match(prompts[0]?.question ?? "", /add generated-0\.txt/);
    assert.deepEqual(prompts[0]?.options, ["✅ Continue", "❌ Skip"]);
    const runtimeEvents = sent
      .filter((event) => event.kind === "runtime_event")
      .map((event) => event.event);
    assert.equal(runtimeEvents.some((event) => event.type === "file-change.completed"), false);
    assert.ok(runtimeEvents.some((event) => event.type === "runtime.warning"
      && /Skipped 26 unreported snapshot file changes/.test(String(event.message ?? ""))));
  });

  it("passes command output through runtime events", async () => {
    /** @type {Array<{ inspects: MessageInspectState[], updates: MessageHandleUpdate[] }>} */
    const handles = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (_event) => {
          /** @type {{ inspects: MessageInspectState[], updates: MessageHandleUpdate[] }} */
          const entry = {
            inspects: [],
            updates: [],
          };
          const handle = /** @type {MessageHandle} */ ({
            transportHandleId: `handle-${handles.length + 1}`,
            update: async (update) => { entry.updates.push(update); },
            setInspect: (inspect) => { if (inspect) entry.inspects.push(inspect); },
          });
          handles.push(entry);
          return handle;
        },
        reply: async () => undefined,
        select: async () => "",
        confirm: async () => true,
      },
      null,
      VISIBLE_TOOL_OUTPUT,
    );

    await emitRuntimeCommand(
      hooks,
      "sed -n '1,20p' src/app.js",
      "completed",
      "  1→ const value = 1;\n  2→ const value = 2;",
    );

    assert.equal(handles.length, 1);
    assert.deepEqual(handles.map((entry) => entry.inspects.length), [0]);
  });

  it("passes search command output through runtime events", async () => {
    /** @type {Array<{ inspects: MessageInspectState[] }>} */
    const handles = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (_event) => {
          /** @type {{ inspects: MessageInspectState[] }} */
          const entry = {
            inspects: [],
          };
          const handle = /** @type {MessageHandle} */ ({
            transportHandleId: `handle-${handles.length + 1}`,
            update: async () => {},
            setInspect: (inspect) => { if (inspect) entry.inspects.push(inspect); },
          });
          handles.push(entry);
          return handle;
        },
        reply: async () => undefined,
        select: async () => "",
        confirm: async () => true,
      },
      "/repo",
      VISIBLE_TOOL_OUTPUT,
    );

    await emitRuntimeCommand(hooks, "rg -n \"needle\" src", "started");
    await emitRuntimeCommand(hooks, "rg -n \"needle\" src", "completed", "src/app.js:12:needle");

    assert.equal(handles.length, 2);
    assert.deepEqual(handles.map((entry) => entry.inspects.length), [0, 0]);
  });

  it("passes commands with no output through runtime events", async () => {
    /** @type {Array<{ inspects: MessageInspectState[] }>} */
    const handles = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (_event) => {
          /** @type {{ inspects: MessageInspectState[] }} */
          const entry = {
            inspects: [],
          };
          const handle = /** @type {MessageHandle} */ ({
            transportHandleId: `handle-${handles.length + 1}`,
            update: async () => {},
            setInspect: (inspect) => { if (inspect) entry.inspects.push(inspect); },
          });
          handles.push(entry);
          return handle;
        },
        reply: async () => undefined,
        select: async () => "",
        confirm: async () => true,
      },
      "/repo",
      VISIBLE_TOOL_OUTPUT,
    );

    await emitRuntimeCommand(hooks, "ls -a", "started");
    await emitRuntimeCommand(hooks, "ls -a", "completed");

    assert.equal(handles.length, 2);
    assert.deepEqual(handles.map((entry) => entry.inspects.length), [0, 0]);
  });
});
