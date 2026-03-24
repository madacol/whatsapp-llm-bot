import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";

/**
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 * }}
 */
function createSubject() {
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
    () => {},
    null,
  );
  return { hooks, sent };
}

/**
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 *   workingStates: boolean[],
 * }}
 */
function createSubjectWithWorkingSpy() {
  /** @type {Array<{ event: OutboundEvent, kind: "send" | "reply" }>} */
  const sent = [];
  /** @type {boolean[]} */
  const workingStates = [];
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
      workingStates.push(true);
    },
    () => {
      workingStates.push(false);
      workingStates.push(true);
    },
    null,
  );
  return {
    hooks,
    sent,
    workingStates,
  };
}

/**
 * @param {string | null} cwd
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ event: OutboundEvent, kind: "send" | "reply" }>,
 * }}
 */
function createSubjectWithCwd(cwd) {
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
    () => {},
    cwd,
  );
  return { hooks, sent };
}

describe("buildAgentIoHooks", () => {
  it("maps plan events to an llm reply", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onPlan?.("Step 1\nStep 2");

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "reply");
    assert.equal(sent[0].event.kind, "plan");
  });

  it("re-arms composing after intermediate outbound progress messages", async () => {
    const subject = createSubjectWithWorkingSpy();

    await subject.hooks.onLlmResponse?.("Still working");
    await subject.hooks.onToolResult?.([{ type: "text", text: "Intermediate tool output" }]);

    assert.equal(subject.sent.length, 2);
    assert.deepEqual(subject.workingStates, [false, true, false, true]);
  });

  it("does not wait for typing restarts before returning", async () => {
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
      () => new Promise((resolve) => {
        resolveRestart = resolve;
      }),
      null,
    );

    let completed = false;
    const pending = hooks.onLlmResponse?.("Still working").then(() => {
      completed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(completed, true, "Hook should resolve before the background typing restart completes");
    resolveRestart?.();
    await pending;
  });

  it("maps command start events to a tool-call message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onCommand?.({ command: "npm test", status: "started" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].event.kind, "tool_call");
  });

  it("renders searchable shell commands as searched summaries", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo");
    await hooks.onCommand?.({ command: "rg -n \"needle\" src", status: "started" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event.kind, "tool_call");
    if (sent[0].event.kind !== "tool_call") {
      assert.fail("Expected tool_call event");
    }
    assert.equal(sent[0].event.presentation.summary, "*Search*  \"needle\" in `src`");
    assert.equal(sent[0].event.presentation.kind, "bash");
    assert.equal(sent[0].event.presentation.command, "rg -n \"needle\" src");
  });

  it("does not send a separate success message for completed commands", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "pwd", status: "completed", output: "/repo\n" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event.kind, "tool_call");
  });

  it("maps file changes to a tool-result message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].event.kind, "file_change");
  });

  it("maps file reads to a tool-call message", async () => {
    const { hooks, sent } = createSubject();
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
      null,
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
      "/repo",
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
    assert.equal(inspect.presentation.summary, "*Search*  \"needle\" in `src`");
    assert.equal(inspect.output, "src/app.js:12:needle");
  });

  it("keeps semantic inspect state available for classified commands with no output", async () => {
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
      "/repo",
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
    assert.equal(inspect.presentation.summary, "*List*  `.`");
    assert.equal(inspect.output, "");
  });
});
