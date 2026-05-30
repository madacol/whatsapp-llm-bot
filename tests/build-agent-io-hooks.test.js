import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { buildToolPresentation } from "../tool-presentation-model.js";

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
    async () => {},
    async () => {},
    () => {},
    null,
    visibility,
  );
  return { hooks, sent };
}

/**
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 *   presenceEvents: string[],
 * }}
 */
function createSubjectWithWorkingSpy(visibility = DEFAULT_OUTPUT_VISIBILITY) {
  /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
  const sent = [];
  /** @type {string[]} */
  const presenceEvents = [];
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
    async () => {
      presenceEvents.push("keepAlive");
    },
    async () => {
      presenceEvents.push("end");
    },
    () => {
      presenceEvents.push("refresh");
    },
    null,
    visibility,
  );
  return {
    hooks,
    sent,
    presenceEvents,
  };
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
    async () => {},
    async () => {},
    () => {},
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
    async () => {},
    async () => {},
    () => {},
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

  it("refreshes the presence lease for tool-result progress, but not for llm or tool-call display", async () => {
    const subject = createSubjectWithWorkingSpy(VISIBLE_TOOL_OUTPUT);

    await subject.hooks.onLlmResponse?.("Still working");
    await subject.hooks.onToolCall?.({
      id: "tool-1",
      name: "spawn_agent",
      arguments: JSON.stringify({ message: "Investigate the failure" }),
    });
    await subject.hooks.onToolResult?.([{ type: "text", text: "Intermediate tool output" }]);

    assert.equal(subject.sent.length, 3);
    assert.deepEqual(subject.presenceEvents, ["refresh"]);
  });

  it("does not wait for typing refreshes before returning", async () => {
    /** @type {(() => void) | undefined} */
    let resolveRestart;
    const hooks = buildAgentIoHooks(
      {
        send: async () => undefined,
        reply: async () => undefined,
        select: async () => "",
        confirm: async () => true,
      },
      async () => {},
      async () => {},
      () => new Promise((resolve) => {
        resolveRestart = resolve;
      }),
      null,
    );

    let completed = false;
    const pending = hooks.onToolResult?.([{ type: "text", text: "Still working" }]).then(() => {
      completed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(completed, true, "Hook should resolve before the background typing refresh completes");
    resolveRestart?.();
    await pending;
  });

  it("emits command starts as runtime events", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);
    await hooks.onCommand?.({ command: "npm test", status: "started" });

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

  it("emits compact activity events instead of pre-rendered WhatsApp text", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    await hooks.onFileRead?.({ command: "sed -n '1,20p' src/app.js", paths: ["src/app.js"] });
    await hooks.onCommand?.({ command: "pnpm type-check", status: "started" });

    assert.deepEqual(sent.map((entry) => entry.event), [
      {
        kind: "compact_tool_activity",
        cwd: "/repo",
        activity: {
          type: "file_read",
          status: "started",
          command: "sed -n '1,20p' src/app.js",
          paths: ["src/app.js"],
        },
      },
      {
        kind: "compact_tool_activity",
        cwd: "/repo",
        activity: {
          type: "command",
          status: "started",
          command: "pnpm type-check",
        },
      },
    ]);
  });

  it("suppresses no-op ACP editing-files placeholder tool calls", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    const toolCall = { id: "acp-editing-files", name: "Editing files", arguments: "{}" };
    await hooks.onToolCall?.(toolCall);
    await hooks.onToolComplete?.(toolCall);

    assert.deepEqual(sent, []);
  });

  it("emits compact tool lifecycle events with semantic presentation payloads", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });
    const toolCall = {
      id: "tool-complete-1",
      name: "spawn_agent",
      arguments: JSON.stringify({ message: "hello" }),
    };
    await hooks.onToolCall?.(toolCall);
    await hooks.onToolComplete?.(toolCall);

    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.event.kind, "compact_tool_activity");
    assert.equal(sent[0]?.event.kind === "compact_tool_activity" ? sent[0].event.activity.type : "", "tool");
    assert.equal(sent[0]?.event.kind === "compact_tool_activity" && sent[0].event.activity.type === "tool" ? sent[0].event.activity.presentation?.kind : "", "activity");
    assert.deepEqual(sent[1]?.event, {
      kind: "compact_tool_activity",
      cwd: "/repo",
      activity: {
        type: "tool",
        status: "completed",
        toolCall,
      },
    });
  });

  it("renders edit diffs even when generic tool progress is compacted", async () => {
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
      assert.fail("Expected edit tool call to bypass compact text");
    }
    assert.equal(sent[0].event.presentation.kind, "file");
    assert.equal(sent[0].event.presentation.toolName, "Edit");
  });

  it("emits compact command failures instead of a separate error message", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });

    await hooks.onCommand?.({ command: "pnpm test", status: "started" });
    await hooks.onCommand?.({ command: "pnpm test", status: "failed", output: "boom" });

    assert.deepEqual(sent.map((entry) => entry.event), [
      {
        kind: "compact_tool_activity",
        cwd: "/repo",
        activity: { type: "command", status: "started", command: "pnpm test" },
      },
      {
        kind: "compact_tool_activity",
        cwd: "/repo",
        activity: { type: "command", status: "failed", command: "pnpm test", output: "boom" },
      },
    ]);
  });

  it("emits compact close events before llm and file-change messages", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", { ...DEFAULT_OUTPUT_VISIBILITY, toolDetails: false });
    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "pnpm type-check", status: "started" });
    await hooks.onLlmResponse?.("Done");
    await hooks.onCommand?.({ command: "git diff", status: "started" });

    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "git diff", status: "started" });
    await hooks.onFileChange?.({ path: "/repo/src/app.js", summary: "Updated file" });
    await hooks.onCommand?.({ command: "ls", status: "started" });

    assert.deepEqual(sent.map((entry) => entry.event.kind), [
      "compact_tool_activity",
      "compact_tool_activity",
      "compact_tool_activity",
      "content",
      "compact_tool_activity",
      "compact_tool_activity",
      "compact_tool_activity",
      "compact_tool_activity",
      "runtime_event",
      "compact_tool_activity",
    ]);
    assert.deepEqual(sent.filter((entry) => (
      entry.event.kind === "compact_tool_activity"
      && entry.event.activity.type === "close"
    )).length, 2);
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
    await hooks.onCommand?.({ command: "rg -n \"needle\" src", status: "started" });

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
    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "pwd", status: "completed", output: "/repo\n" });

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
      async () => {},
      async () => {},
      () => {},
      "/repo",
      VISIBLE_TOOL_OUTPUT,
    );

    await hooks.onCommand?.({ command: "pnpm test", status: "started" });
    await hooks.onCommand?.({ command: "pnpm test", status: "failed", output: "boom" });

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

  it("emits file reads as runtime events", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);
    await hooks.onFileRead?.({ command: "sed -n '1,20p' src/app.js", paths: ["src/app.js"] });

    assertSingleSentEvent(sent, "send", "runtime_event");
    if (sent[0].event.kind !== "runtime_event") {
      assert.fail("Expected runtime_event");
    }
    assert.equal(sent[0].event.event.type, "file-read.started");
    assert.equal(sent[0].event.event.provider, "codex");
    assert.deepEqual(sent[0].event.event.fileRead, {
      command: "sed -n '1,20p' src/app.js",
      paths: ["src/app.js"],
    });
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

  it("keeps file-read command output inspectable without Read presentation", async () => {
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
      async () => {},
      async () => {},
      () => {},
      null,
      VISIBLE_TOOL_OUTPUT,
    );

    await hooks.onFileRead?.({
      command: "sed -n '1,20p' src/app.js",
      paths: ["src/app.js"],
    });
    await hooks.onCommand?.({
      command: "sed -n '1,20p' src/app.js",
      status: "completed",
      output: "  1→ const value = 1;\n  2→ const value = 2;",
    });

    assert.equal(handles.length, 2);
    assert.equal(handles[0]?.inspects.length, 1);
    const inspect = handles[0]?.inspects[0];
    assert.ok(inspect && inspect.kind === "text");
    if (!inspect || inspect.kind !== "text") {
      assert.fail("Expected text inspect state");
    }
    assert.equal(inspect.text, "  1→ const value = 1;\n  2→ const value = 2;");
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
      async () => {},
      async () => {},
      () => {},
      "/repo",
      VISIBLE_TOOL_OUTPUT,
    );

    await hooks.onCommand?.({
      command: "rg -n \"needle\" src",
      status: "started",
    });
    await hooks.onCommand?.({
      command: "rg -n \"needle\" src",
      status: "completed",
      output: "src/app.js:12:needle",
    });

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
      async () => {},
      async () => {},
      () => {},
      "/repo",
      VISIBLE_TOOL_OUTPUT,
    );

    await hooks.onCommand?.({
      command: "ls -a",
      status: "started",
    });
    await hooks.onCommand?.({
      command: "ls -a",
      status: "completed",
    });

    assert.equal(handles.length, 2);
    assert.deepEqual(handles.map((entry) => entry.inspects.length), [0, 0]);
  });
});
