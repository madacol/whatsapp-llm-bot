import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { buildToolPresentation } from "../tool-presentation-model.js";

const VISIBLE_TOOL_OUTPUT = {
  ...DEFAULT_OUTPUT_VISIBILITY,
  tools: true,
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
          keyId: "reasoning-msg-1",
          isImage: false,
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

describe("buildAgentIoHooks", () => {
  it("maps plan events to an llm reply", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onPlan?.(buildToolPresentation("update_plan", {
      explanation: "Keep the user informed.",
      plan: [
        { step: "Patch the formatter", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    }, undefined, undefined, undefined));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "reply");
    assert.equal(sent[0].event.kind, "plan");
    if (sent[0].event.kind !== "plan") {
      assert.fail("Expected plan event");
    }
    assert.equal(sent[0].event.presentation.summary, "*Plan*  _Working on: Patch the formatter_");
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
    await subject.hooks.onToolCall?.({ id: "tool-1", name: "run_bash", arguments: "{\"command\":\"echo hi\"}" });
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

  it("maps command start events to a tool-call message", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);
    await hooks.onCommand?.({ command: "npm test", status: "started" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].event.kind, "tool_call");
  });

  it("shows one debounced compact tool summary when visibility disables tools", async () => {
    /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
    const sent = [];
    /** @type {MessageHandleUpdate[]} */
    const updates = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => {
          sent.push({ event, kind: "send" });
          return {
            keyId: "compact-tools-1",
            isImage: false,
            update: async (update) => { updates.push(update); },
            setInspect: () => {},
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
      { ...DEFAULT_OUTPUT_VISIBILITY, tools: false },
    );

    await hooks.onFileRead?.({ command: "sed -n '1,20p' src/app.js", paths: ["src/app.js"] });
    await hooks.onCommand?.({ command: "pnpm type-check", status: "started" });
    await hooks.onToolCall?.({ id: "tool-1", name: "run_bash", arguments: "{\"command\":\"git diff\"}" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.event.kind, "content");
    if (sent[0]?.event.kind !== "content") {
      assert.fail("Expected compact content event");
    }
    assert.equal(sent[0].event.source, "plain");
    assert.equal(sent[0].event.content, "🔧 *Read*  `src/app.js`");

    assert.equal(updates.length, 0, "expected debounce to defer compact edits");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(updates, [{
      kind: "text",
      text: "🔧 *Read*  `src/app.js`\n🔧 *Bash*  `pnpm type-check`\n🔧 *Bash*  `git diff`",
    }]);
  });

  it("renders edit diffs even when generic tool progress is compacted", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", {
      ...DEFAULT_OUTPUT_VISIBILITY,
      tools: false,
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

  it("keeps only the last 3 compact tool entries when visibility disables tools", async () => {
    /** @type {MessageHandleUpdate[]} */
    const updates = [];
    const hooks = buildAgentIoHooks(
      {
        send: async () => ({
          keyId: "compact-tools-2",
          isImage: false,
          update: async (update) => { updates.push(update); },
          setInspect: () => {},
        }),
        reply: async () => undefined,
        select: async () => "",
        confirm: async () => true,
      },
      async () => {},
      async () => {},
      () => {},
      "/repo",
      { ...DEFAULT_OUTPUT_VISIBILITY, tools: false },
    );

    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "pnpm type-check", status: "started" });
    await hooks.onFileRead?.({ command: "sed -n '1,20p' src/app.js", paths: ["src/app.js"] });
    await hooks.onToolCall?.({ id: "tool-2", name: "run_bash", arguments: "{\"command\":\"git diff\"}" });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(updates[updates.length - 1], {
      kind: "text",
      text: "... +1 earlier tools\n🔧 *Bash*  `pnpm type-check`\n🔧 *Read*  `src/app.js`\n🔧 *Bash*  `git diff`",
    });
  });

  it("marks the existing compact command line as failed instead of sending a new error message", async () => {
    /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
    const sent = [];
    /** @type {MessageHandleUpdate[]} */
    const updates = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => {
          sent.push({ event, kind: "send" });
          return {
            keyId: "compact-tools-failed-command",
            isImage: false,
            update: async (update) => { updates.push(structuredClone(update)); },
            setInspect: () => {},
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
      { ...DEFAULT_OUTPUT_VISIBILITY, tools: false },
    );

    await hooks.onCommand?.({ command: "pnpm test", status: "started" });
    await hooks.onCommand?.({ command: "pnpm test", status: "failed", output: "boom" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.event.kind, "content");
    assert.deepEqual(updates, [{
      kind: "text",
      text: "❌ *Bash*  `pnpm test`",
    }]);
  });

  it("starts a new compact tool message after an llm reply", async () => {
    /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
    const sent = [];
    /** @type {MessageHandleUpdate[][]} */
    const handleUpdates = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => {
          sent.push({ event, kind: "send" });
          const updates = [];
          handleUpdates.push(updates);
          return {
            keyId: `compact-tools-${handleUpdates.length}`,
            isImage: false,
            update: async (update) => { updates.push(structuredClone(update)); },
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
      async () => {},
      async () => {},
      () => {},
      "/repo",
      { ...DEFAULT_OUTPUT_VISIBILITY, tools: false },
    );

    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "pnpm type-check", status: "started" });
    await hooks.onLlmResponse?.("Done");
    await hooks.onToolCall?.({ id: "tool-3", name: "run_bash", arguments: "{\"command\":\"git diff\"}" });

    assert.equal(sent.length, 3);
    assert.equal(sent[0]?.event.kind, "content");
    assert.equal(sent[1]?.kind, "reply");
    assert.equal(sent[2]?.event.kind, "content");
    if (sent[2]?.event.kind !== "content") {
      assert.fail("Expected a new compact content event after llm reply");
    }
    assert.equal(sent[2].event.source, "plain");
    assert.equal(sent[2].event.content, "🔧 *Bash*  `git diff`");
    assert.deepEqual(handleUpdates[0], [{
      kind: "text",
      text: "🔧 *Bash*  `pwd`\n🔧 *Bash*  `pnpm type-check`",
    }]);
    assert.deepEqual(handleUpdates[1], []);
  });

  it("starts a new compact tool message after a file change message", async () => {
    /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
    const sent = [];
    /** @type {MessageHandleUpdate[][]} */
    const handleUpdates = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (event) => {
          sent.push({ event, kind: "send" });
          const updates = [];
          handleUpdates.push(updates);
          return {
            keyId: `compact-tools-${handleUpdates.length}`,
            isImage: false,
            update: async (update) => { updates.push(structuredClone(update)); },
            setInspect: () => {},
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
      { ...DEFAULT_OUTPUT_VISIBILITY, tools: false },
    );

    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onToolCall?.({ id: "tool-4", name: "run_bash", arguments: "{\"command\":\"git diff\"}" });
    await hooks.onFileChange?.({ path: "/repo/src/app.js", summary: "Updated file" });
    await hooks.onCommand?.({ command: "ls", status: "started" });

    assert.equal(sent.length, 3);
    assert.equal(sent[0]?.event.kind, "content");
    assert.equal(sent[1]?.event.kind, "file_change");
    assert.equal(sent[2]?.event.kind, "content");
    if (sent[2]?.event.kind !== "content") {
      assert.fail("Expected a new compact content event after file change");
    }
    assert.equal(sent[2].event.source, "plain");
    assert.equal(sent[2].event.content, "🔧 *Bash*  `ls`");
    assert.deepEqual(handleUpdates[0], [{
      kind: "text",
      text: "🔧 *Bash*  `pwd`\n🔧 *Bash*  `git diff`",
    }]);
    assert.deepEqual(handleUpdates[2], []);
  });

  it("suppresses tool result progress events when visibility disables tools", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, tools: false });

    await hooks.onToolResult?.([{ type: "text", text: "Intermediate tool output" }]);

    assert.equal(sent.length, 0);
  });

  it("suppresses file change progress when visibility disables changes", async () => {
    const { hooks, sent } = createSubject({ ...DEFAULT_OUTPUT_VISIBILITY, changes: false });

    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assert.equal(sent.length, 0);
  });

  it("renders shell commands as bash summaries", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo", VISIBLE_TOOL_OUTPUT);
    await hooks.onCommand?.({ command: "rg -n \"needle\" src", status: "started" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event.kind, "tool_call");
    if (sent[0].event.kind !== "tool_call") {
      assert.fail("Expected tool_call event");
    }
    assert.equal(sent[0].event.presentation.summary, "*Bash*  `rg -n \"needle\" src`");
    assert.equal(sent[0].event.presentation.kind, "bash");
    assert.equal(sent[0].event.presentation.command, "rg -n \"needle\" src");
  });

  it("does not send a separate success message for completed commands", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);
    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "pwd", status: "completed", output: "/repo\n" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event.kind, "tool_call");
  });

  it("updates the existing tool-call message when a visible command fails", async () => {
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
            keyId: "visible-command-failure",
            isImage: false,
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

    assert.equal(sent.length, 1);
    assert.deepEqual(updates, [{
      kind: "text",
      text: "❌ *Bash*  `pnpm test`",
    }]);
    assert.equal(inspects.length, 1);
    const inspect = inspects[0];
    assert.ok(inspect && inspect.kind === "tool");
    if (!inspect || inspect.kind !== "tool") {
      assert.fail("Expected tool inspect state");
    }
    assert.equal(inspect.presentation.summary, "*Bash*  `pnpm test`");
    assert.equal(inspect.output, "boom");
  });

  it("maps file changes to a tool-result message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].event.kind, "file_change");
  });

  it("maps file reads to a tool-call message", async () => {
    const { hooks, sent } = createSubject(VISIBLE_TOOL_OUTPUT);
    await hooks.onFileRead?.({ command: "sed -n '1,20p' src/app.js", paths: ["src/app.js"] });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].event.kind, "tool_call");
    if (sent[0].event.kind !== "tool_call") {
      assert.fail("Expected tool_call event");
    }
    assert.equal(sent[0].event.presentation.summary, "*Read*  `src/app.js`");
  });

  it("renders file change diffs when present", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileChange?.({
      path: "/tmp/file.js",
      summary: "Updated file",
      oldText: "const value = 1;\n",
      newText: "const value = 2;\n",
      diff: ["--- a/file.js", "+++ b/file.js", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].event.kind, "file_change");
    if (sent[0].event.kind !== "file_change") {
      assert.fail("Expected file_change event");
    }
    assert.equal(sent[0].event.path, "/tmp/file.js");
    assert.equal(sent[0].event.oldText, "const value = 1;\n");
    assert.equal(sent[0].event.newText, "const value = 2;\n");
  });

  it("shortens file change paths and drops redundant summaries", async () => {
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
    assert.equal(sent[0].event.kind, "file_change");
    if (sent[0].event.kind !== "file_change") {
      assert.fail("Expected file_change event");
    }
    assert.equal(sent[0].event.changeKind, "add");
    assert.equal(sent[0].event.cwd, "/repo");
  });

  it("attaches semantic inspect state for codex file reads", async () => {
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
            keyId: `handle-${handles.length + 1}`,
            isImage: false,
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

    assert.equal(handles.length, 1);
    assert.equal(handles[0]?.inspects.length, 1);
    const inspect = handles[0]?.inspects[0];
    assert.ok(inspect && inspect.kind === "tool");
    if (!inspect || inspect.kind !== "tool") {
      assert.fail("Expected tool inspect state");
    }
    assert.equal(inspect.presentation.summary, "*Read*  `src/app.js`");
    assert.equal(inspect.output, "  1→ const value = 1;\n  2→ const value = 2;");
  });

  it("stores search command inspect state without formatting it outside the adapter", async () => {
    /** @type {Array<{ inspects: MessageInspectState[] }>} */
    const handles = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (_event) => {
          const entry = {
            inspects: [],
          };
          const handle = /** @type {MessageHandle} */ ({
            keyId: `handle-${handles.length + 1}`,
            isImage: false,
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

    assert.equal(handles.length, 1);
    const inspect = handles[0]?.inspects[0];
    assert.ok(inspect && inspect.kind === "tool");
    if (!inspect || inspect.kind !== "tool") {
      assert.fail("Expected tool inspect state");
    }
    assert.equal(inspect.presentation.summary, "*Bash*  `rg -n \"needle\" src`");
    assert.equal(inspect.output, "src/app.js:12:needle");
  });

  it("keeps bash inspect state available for commands with no output", async () => {
    /** @type {Array<{ inspects: MessageInspectState[] }>} */
    const handles = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (_event) => {
          const entry = {
            inspects: [],
          };
          const handle = /** @type {MessageHandle} */ ({
            keyId: `handle-${handles.length + 1}`,
            isImage: false,
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

    assert.equal(handles.length, 1);
    const inspect = handles[0]?.inspects[0];
    assert.ok(inspect && inspect.kind === "tool");
    if (!inspect || inspect.kind !== "tool") {
      assert.fail("Expected tool inspect state");
    }
    assert.equal(inspect.presentation.summary, "*Bash*  `ls -a`");
    assert.equal(inspect.output, "");
  });
});
