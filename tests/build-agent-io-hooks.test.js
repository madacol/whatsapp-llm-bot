import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_AUTO_PRESENTED_SNAPSHOT_FILE_CHANGES, buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { buildToolPresentation } from "../whatsapp/tool-presentation-model.js";

const VISIBLE_TOOL_OUTPUT = {
  ...DEFAULT_OUTPUT_VISIBILITY,
  toolDetails: true,
};

/**
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
 * @param {string | null} cwd
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
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 *   reasoningUpdates: MessageHandleUpdate[],
 *   reasoningInspects: MessageInspectState[],
 * }}
 */
function createReasoningSubject(visibility = { ...DEFAULT_OUTPUT_VISIBILITY, thinking: true }) {
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

  it("maps plan events to an llm reply", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onPlan?.(buildToolPresentation("update_plan", {
      explanation: "Keep the user informed.",
      plan: [
        { step: "Patch the formatter", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    }, undefined, undefined, undefined));

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
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, subagents: false });

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
      { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false },
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
      "content",
    ]);
    assert.equal(sent[0]?.event.kind === "runtime_event" ? sent[0].event.event.type : "", "command.started");
    assert.equal(sent[1]?.event.kind === "runtime_event" ? sent[1].event.event.type : "", "command.completed");
    assert.equal(sent[2]?.event.kind === "content" ? sent[2].event.source : "", "llm");
  });

  it("sends one thinking placeholder, then updates it to Thought on completion", async () => {
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
    assert.equal(subject.sent[0].event.kind, "content");
    if (subject.sent[0].event.kind !== "content") {
      assert.fail("Expected content event");
    }
    assert.deepEqual(subject.sent[0].event.content, [{ type: "text", text: "Thinking..." }]);
    assert.deepEqual(subject.reasoningUpdates, [{ kind: "text", text: "Thought" }]);
    assert.equal(subject.reasoningInspects.length, 2);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thinking*",
      text: "_Codex exposed no public reasoning text for this step._",
    });
    assert.deepEqual(subject.reasoningInspects[1], {
      kind: "reasoning",
      summary: "*Thinking*",
      text: "Inspect the file, then patch the bug.",
    });
  });

  it("reports encrypted reasoning honestly when no public reasoning text is available", async () => {
    const subject = createReasoningSubject();

    await subject.hooks.onReasoning?.({
      status: "updated",
      summaryParts: [],
      contentParts: [],
      hasEncryptedContent: true,
    });

    assert.equal(subject.reasoningInspects.length, 1);
    assert.deepEqual(subject.reasoningInspects[0], {
      kind: "reasoning",
      summary: "*Thinking*",
      text: "_Codex returned encrypted reasoning, but no public reasoning text._",
    });
  });

  it("suppresses thinking output when visibility disables it", async () => {
    const subject = createReasoningSubject({ ...DEFAULT_OUTPUT_VISIBILITY, thinking: false });

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
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    await emitRuntimeCommand(hooks, "pnpm type-check", "started");

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event"]);
    assert.equal(sent[0]?.event.kind === "runtime_event" ? sent[0].event.event.type : "", "command.started");
    assert.equal("compact" in sent[0].event, false);
  });

  it("suppresses no-op ACP editing-files placeholder tool calls", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    const toolCall = { id: "acp-editing-files", name: "Editing files", arguments: "{}" };
    await hooks.onToolCall?.(toolCall);
    await hooks.onToolComplete?.(toolCall);

    assert.deepEqual(sent, []);
  });

  it("emits direct tool lifecycle as raw runtime events", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });
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

  it("renders edit diffs even when generic tool progress is hidden", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", {
      ...DEFAULT_OUTPUT_VISIBILITY,
      toolDetails: false,
      changes: true,
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

  it("passes command failures as raw runtime events instead of sending a separate error message", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    await emitRuntimeCommand(hooks, "pnpm test", "started");
    await emitRuntimeCommand(hooks, "pnpm test", "failed", "boom");

    assert.deepEqual(sent.map((entry) => entry.event.kind), ["runtime_event", "runtime_event"]);
    assert.equal(sent[1]?.event.kind === "runtime_event" ? sent[1].event.event.type : "", "command.failed");
  });

  it("passes runtime progress without inserting transport close events", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });
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
      "content",
      "runtime_event",
      "runtime_event",
      "runtime_event",
      "runtime_event",
      "runtime_event",
    ]);
    assert.equal(sent.some((entry) => entry.event.kind === "compact_tool_activity"), false);
  });

  it("keeps runtime progress and non-tool events separate without transport grouping", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    await emitRuntimeCommand(hooks, "pwd", "started");
    await hooks.onPlan?.(buildToolPresentation("update_plan", {
      plan: [{ step: "Inspect output", status: "in_progress" }],
    }));
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
    assert.equal(sent.some((entry) => entry.event.kind === "compact_tool_activity"), false);
  });

  it("suppresses tool result progress events when visibility disables full tool details", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    await hooks.onToolResult?.([{ type: "text", text: "Intermediate tool output" }]);

    assert.equal(sent.length, 0);
  });

  it("suppresses file change progress when visibility disables changes", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, changes: false });

    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assert.equal(sent.length, 0);
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
    /** @type {Array<{ question: string, options: string[] }>} */
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
      raw: { source: "workdir-snapshot" },
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
