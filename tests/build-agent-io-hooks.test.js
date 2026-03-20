import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";

/**
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ source: MessageSource, content: SendContent, kind: "send" | "reply" }>,
 * }}
 */
function createSubject() {
  /** @type {Array<{ source: MessageSource, content: SendContent, kind: "send" | "reply" }>} */
  const sent = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (source, content) => {
        sent.push({ source, content, kind: "send" });
        return undefined;
      },
      reply: async (source, content) => {
        sent.push({ source, content, kind: "reply" });
        return undefined;
      },
      select: async () => "",
      confirm: async () => true,
    },
    async () => {},
    null,
  );
  return { hooks, sent };
}

/**
 * @param {string | null} cwd
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ source: MessageSource, content: SendContent, kind: "send" | "reply" }>,
 * }}
 */
function createSubjectWithCwd(cwd) {
  /** @type {Array<{ source: MessageSource, content: SendContent, kind: "send" | "reply" }>} */
  const sent = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (source, content) => {
        sent.push({ source, content, kind: "send" });
        return undefined;
      },
      reply: async (source, content) => {
        sent.push({ source, content, kind: "reply" });
        return undefined;
      },
      select: async () => "",
      confirm: async () => true,
    },
    async () => {},
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
    assert.equal(sent[0].source, "llm");
  });

  it("maps command start events to a tool-call message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onCommand?.({ command: "npm test", status: "started" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].source, "tool-call");
  });

  it("renders searchable shell commands as searched summaries", async () => {
    const { hooks, sent } = createSubjectWithCwd("/repo");
    await hooks.onCommand?.({ command: "rg -n \"needle\" src", status: "started" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].source, "tool-call");
    assert.equal(sent[0].content, "*Searched*\nSearch \"needle\" in `src`");
  });

  it("does not send a separate success message for completed commands", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onCommand?.({ command: "pwd", status: "started" });
    await hooks.onCommand?.({ command: "pwd", status: "completed", output: "/repo\n" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].source, "tool-call");
  });

  it("maps file changes to a tool-result message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].source, "tool-call");
  });

  it("maps file reads to a tool-call message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileRead?.({ command: "sed -n '1,20p' src/app.js", paths: ["src/app.js"] });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].source, "tool-call");
    assert.equal(sent[0].content, "*Explored*\nRead `src/app.js`");
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
    assert.equal(sent[0].source, "tool-call");
    const content = /** @type {ToolContentBlock[]} */ (sent[0].content);
    assert.deepEqual(content, [{
      type: "diff",
      oldStr: "const value = 1;\n",
      newStr: "const value = 2;\n",
      language: "javascript",
      caption: "*File changed*  `/tmp/file.js`\nUpdated file",
    }]);
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
    assert.equal(sent[0].source, "tool-call");
    const content = /** @type {ToolContentBlock[]} */ (sent[0].content);
    assert.deepEqual(content, [{
      type: "diff",
      oldStr: "",
      newStr: "export const value = 1;\n",
      language: "javascript",
      caption: "*File added*  `src/file.js`",
    }]);
  });

  it("registers inspect output for codex file reads", async () => {
    /** @type {Array<{ callback: ReactionCallback, edits: string[] }>} */
    const handles = [];
    const hooks = buildAgentIoHooks(
      {
        send: async (_source, _content) => {
          const entry = {
            callback: /** @type {ReactionCallback} */ (() => {}),
            edits: [],
          };
          /** @type {ReactionCallback | null} */
          let reactionCallback = null;
          const handle = /** @type {MessageHandle} */ ({
            keyId: `handle-${handles.length + 1}`,
            isImage: false,
            edit: async (text) => {
              entry.edits.push(text);
            },
            onReaction: (callback) => {
              reactionCallback = callback;
              return () => {};
            },
          });
          entry.callback = (emoji, senderId) => reactionCallback?.(emoji, senderId);
          handles.push(entry);
          return handle;
        },
        reply: async () => undefined,
        select: async () => "",
        confirm: async () => true,
      },
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
    handles[0]?.callback("👁", "user-1");
    assert.equal(handles[0]?.edits.length, 1);
    assert.equal(handles[0]?.edits[0], [
      "*Explored*",
      "Read `src/app.js`",
      "",
      "```",
      "const value = 1;",
      "const value = 2;",
      "```",
    ].join("\n"));
  });
});
