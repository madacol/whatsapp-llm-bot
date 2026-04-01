import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodexThreadOptions, buildCodexTurnInput, startCodexRun } from "../harnesses/codex-runner.js";
import { formatToolFlowSummary } from "../tool-flow-presentation.js";

/**
 * @param {string} keyId
 * @returns {{
 *   handle: MessageHandle,
 *   updates: MessageHandleUpdate[],
 *   inspects: Array<MessageInspectState | null>,
 * }}
 */
function createRecordedHandle(keyId) {
  /** @type {MessageHandleUpdate[]} */
  const updates = [];
  /** @type {Array<MessageInspectState | null>} */
  const inspects = [];

  return {
    updates,
    inspects,
    handle: {
      keyId,
      isImage: false,
      update: async (update) => {
        updates.push(structuredClone(update));
      },
      setInspect: (inspect) => {
        inspects.push(inspect == null ? null : structuredClone(inspect));
      },
    },
  };
}

describe("buildCodexThreadOptions", () => {
  it("maps shared run config to Codex SDK thread options", () => {
    assert.deepEqual(buildCodexThreadOptions({
      workdir: "/repo",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      additionalDirectories: ["/tmp"],
    }), {
      workingDirectory: "/repo",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      additionalDirectories: ["/tmp"],
      skipGitRepoCheck: true,
    });
  });
});

describe("buildCodexTurnInput", () => {
  it("prepends the resolved system prompt for Codex turns", () => {
    assert.equal(
      buildCodexTurnInput("Continue", "Use available tools."),
      [
        "Follow these instructions for this run:",
        "Use available tools.",
        "",
        "User request:",
        "Continue",
      ].join("\n"),
    );
  });

  it("leaves the prompt untouched when no system prompt is provided", () => {
    assert.equal(buildCodexTurnInput("Continue", ""), "Continue");
  });
});

describe("startCodexRun", () => {
  it("uses the SDK-managed Codex binary by default", async () => {
    /** @type {import("@openai/codex-sdk").CodexOptions | undefined} */
    let receivedOptions;

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    }, {
      createCodex: (options) => {
        receivedOptions = options;
        return {
          startThread: () => ({
            id: "sess-123",
            runStreamed: async () => ({
              events: (async function* () {
                yield {
                  type: "thread.started",
                  thread_id: "sess-123",
                };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cached_input_tokens: 0,
                  },
                };
              })(),
            }),
          }),
          resumeThread: () => {
            throw new Error("resumeThread should not be called");
          },
        };
      },
    });

    await started.done;

    assert.deepEqual(receivedOptions, {});
  });

  it("returns streamed assistant text from SDK events", async () => {
    /** @type {string[]} */
    const commands = [];
    /** @type {Array<{ command: string, paths: string[] }>} */
    const fileReads = [];
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {Array<{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" }>} */
    const fileChanges = [];
    /** @type {string[]} */
    const assistantMessages = [];
    /** @type {Array<{ cost: string, tokens: { prompt: number, completion: number, cached: number } }>} */
    const usageEvents = [];

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runner-"));
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src/app.js"), "old\n", "utf8");

    /** @type {import("@openai/codex-sdk").ThreadEvent[]} */
    const events = [
      { type: "thread.started", thread_id: "sess-123" },
      {
        type: "item.started",
        item: {
          id: "cmd-read",
          type: "command_execution",
          command: "sed -n '1,20p' src/app.js",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.started",
        item: {
          id: "cmd-patch",
          type: "command_execution",
          command: [
            "apply_patch <<'PATCH'",
            "*** Begin Patch",
            "*** Update File: src/app.js",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
            "PATCH",
          ].join("\n"),
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "todo-1",
          type: "todo_list",
          items: [
            { text: "Step 1", completed: false },
            { text: "Step 2", completed: true },
          ],
        },
      },
      {
        type: "item.completed",
        item: {
          id: "patch-1",
          type: "file_change",
          changes: [{ path: "src/app.js", kind: "update" }],
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "msg-1",
          type: "agent_message",
          text: "Applied fix",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cached_input_tokens: 3,
        },
      },
    ];

    /** @type {{ threadOptions?: import("@openai/codex-sdk").ThreadOptions, prompt?: string, signalAborted?: boolean }} */
    const observed = {};

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      externalInstructions: "Use available tools.",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: tempDir,
        model: "gpt-5.4",
      },
      hooks: {
        onCommand: async ({ command, status }) => {
          commands.push(`${status}:${command}`);
        },
        onFileRead: async (event) => {
          fileReads.push(event);
        },
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
        },
        onFileChange: async (event) => {
          fileChanges.push(event);
        },
        onLlmResponse: async (text) => {
          assistantMessages.push(text);
        },
        onUsage: async (cost, tokens) => {
          usageEvents.push({ cost, tokens });
        },
      },
    }, {
      createCodex: () => ({
        startThread: (threadOptions) => {
          observed.threadOptions = threadOptions;
          return {
            id: "sess-123",
            runStreamed: async (prompt, turnOptions) => {
              observed.prompt = /** @type {string} */ (prompt);
              observed.signalAborted = !!turnOptions?.signal?.aborted;
              return {
                events: (async function* () {
                  for (const event of events) {
                    yield event;
                  }
                })(),
              };
            },
          };
        },
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    const result = await started.done;

    assert.equal(observed.prompt, buildCodexTurnInput("Continue", "Use available tools."));
    assert.deepEqual(observed.threadOptions, {
      workingDirectory: tempDir,
      model: "gpt-5.4",
      skipGitRepoCheck: true,
    });
    assert.equal(observed.signalAborted, false);
    assert.equal(result.sessionId, "sess-123");
    assert.deepEqual(commands, ["started:apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/app.js\n@@\n-old\n+new\n*** End Patch\nPATCH"]);
    assert.deepEqual(fileReads, [{ command: "sed -n '1,20p' src/app.js", paths: ["src/app.js"] }]);
    assert.deepEqual(toolCalls, [{
      id: "todo-1",
      name: "update_plan",
      arguments: JSON.stringify({
        items: [
          { text: "Step 1", completed: false },
          { text: "Step 2", completed: true },
        ],
      }),
    }]);
    assert.deepEqual(fileChanges, [{
      path: "src/app.js",
      summary: "src/app.js (update)",
      kind: "update",
      oldText: "old\n",
      newText: "new\n",
      diff: ["--- a/src/app.js", "+++ b/src/app.js", "@@", "-old", "+new"].join("\n"),
    }]);
    assert.deepEqual(assistantMessages, ["Applied fix"]);
    assert.deepEqual(result.result.response, [{ type: "markdown", text: "Applied fix" }]);
    assert.deepEqual(result.result.usage, {
      promptTokens: 11,
      completionTokens: 7,
      cachedTokens: 3,
      cost: 0,
    });
    assert.deepEqual(usageEvents, [{
      cost: "0.000000",
      tokens: { prompt: 11, completion: 7, cached: 3 },
    }]);
  });

  it("forwards reasoning events from Codex runs", async () => {
    /** @type {Array<{ status: "started" | "updated" | "completed", itemId?: string, summaryParts: string[], contentParts: string[], text?: string, hasEncryptedContent?: boolean }>} */
    const reasoningEvents = [];

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-reason-1",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "reason-1",
                  type: "reasoning",
                  text: "",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "reason-1",
                  type: "reasoning",
                  text: "Inspect the file, then patch it.",
                },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cached_input_tokens: 0,
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(reasoningEvents, [
      {
        status: "started",
        itemId: "reason-1",
        summaryParts: [],
        contentParts: [],
      },
      {
        status: "completed",
        itemId: "reason-1",
        summaryParts: [],
        contentParts: ["Inspect the file, then patch it."],
        text: "Inspect the file, then patch it.",
      },
    ]);
  });

  it("emits one file-change event per changed file when Codex reports a batched file_change item", async () => {
    /** @type {Array<{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update", oldText?: string, newText?: string }>} */
    const fileChanges = [];

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runner-batched-file-change-"));
    await fs.mkdir(path.join(tempDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "plain.txt"), "before\n", "utf8");
    await fs.writeFile(path.join(tempDir, "nested/delete-me.txt"), "gone soon\n", "utf8");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: tempDir,
      },
      hooks: {
        onFileChange: async (event) => {
          fileChanges.push(event);
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-batch-1",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "cmd-read",
                  type: "command_execution",
                  command: "cat plain.txt nested/delete-me.txt",
                  aggregated_output: "",
                  status: "in_progress",
                },
              };

              await fs.writeFile(path.join(tempDir, "draft.txt"), "draft version\n", "utf8");
              await fs.writeFile(path.join(tempDir, "plain.txt"), "after\n", "utf8");
              await fs.rm(path.join(tempDir, "nested/delete-me.txt"));

              yield {
                type: "item.completed",
                item: {
                  id: "patch-batch-1",
                  type: "file_change",
                  changes: [
                    { path: path.join(tempDir, "draft.txt"), kind: "add" },
                    { path: path.join(tempDir, "nested/delete-me.txt"), kind: "delete" },
                    { path: path.join(tempDir, "plain.txt"), kind: "update" },
                  ],
                  status: "completed",
                },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cached_input_tokens: 0,
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(fileChanges, [
      {
        path: path.join(tempDir, "draft.txt"),
        summary: `${path.join(tempDir, "draft.txt")} (add)`,
        kind: "add",
        newText: "draft version\n",
        diff: [
          `--- a/${path.join(tempDir, "draft.txt")}`,
          `+++ b/${path.join(tempDir, "draft.txt")}`,
          "@@ -0,0 +1,1 @@",
          "+draft version",
        ].join("\n"),
      },
      {
        path: path.join(tempDir, "nested/delete-me.txt"),
        summary: `${path.join(tempDir, "nested/delete-me.txt")} (delete)`,
        kind: "delete",
        oldText: "gone soon\n",
        diff: [
          `--- a/${path.join(tempDir, "nested/delete-me.txt")}`,
          `+++ b/${path.join(tempDir, "nested/delete-me.txt")}`,
          "@@ -1,1 +0,0 @@",
          "-gone soon",
        ].join("\n"),
      },
      {
        path: path.join(tempDir, "plain.txt"),
        summary: `${path.join(tempDir, "plain.txt")} (update)`,
        kind: "update",
        oldText: "before\n",
        newText: "after\n",
        diff: [
          `--- a/${path.join(tempDir, "plain.txt")}`,
          `+++ b/${path.join(tempDir, "plain.txt")}`,
          "@@ -1,1 +1,1 @@",
          "-before",
          "+after",
        ].join("\n"),
      },
    ]);
  });

  it("sends paused then composing when Codex reports a tool has started", async () => {
    /** @type {string[]} */
    const eventOrder = [];

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {
        onLlmResponse: async (text) => {
          eventOrder.push(`llm:${text}`);
        },
        onToolCall: async (toolCall) => {
          eventOrder.push(`tool:${toolCall.name}`);
          return undefined;
        },
        onComposing: async () => {
          eventOrder.push("composing");
        },
        onPaused: async () => {
          eventOrder.push("paused");
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started", thread_id: "sess-123" };
              yield {
                type: "item.completed",
                item: {
                  id: "msg-1",
                  type: "agent_message",
                  text: "Thinking...",
                },
              };
              yield {
                type: "item.started",
                item: {
                  id: "tool-1",
                  type: "mcp_tool_call",
                  tool: "run_bash",
                  arguments: { command: "sleep 3" },
                },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cached_input_tokens: 0,
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(eventOrder, [
      "llm:Thinking...",
      "tool:run_bash",
      "paused",
      "composing",
    ]);
  });

  it("sends paused then composing when Codex reports a command execution has started", async () => {
    /** @type {string[]} */
    const eventOrder = [];

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {
        onCommand: async ({ command, status }) => {
          eventOrder.push(`command:${status}:${command}`);
          return undefined;
        },
        onComposing: async () => {
          eventOrder.push("composing");
        },
        onPaused: async () => {
          eventOrder.push("paused");
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started", thread_id: "sess-123" };
              yield {
                type: "item.started",
                item: {
                  id: "cmd-1",
                  type: "command_execution",
                  command: "sleep 5",
                  aggregated_output: "",
                  status: "in_progress",
                },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cached_input_tokens: 0,
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(eventOrder, [
      "command:started:sleep 5",
      "paused",
      "composing",
    ]);
  });

  it("surfaces mcp tool calls and wires inspect for text results", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    const recorded = createRecordedHandle("tool-msg-1");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          return recorded.handle;
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "tool-1",
                  type: "mcp_tool_call",
                  server: "functions",
                  tool: "spawn_agent",
                  arguments: { message: "hello" },
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "tool-1",
                  type: "mcp_tool_call",
                  server: "functions",
                  tool: "spawn_agent",
                  arguments: { message: "hello" },
                  result: {
                    content: [{ type: "text", text: "agent-pass-2" }],
                    structured_content: null,
                  },
                  status: "completed",
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(toolCalls, [{
      id: "tool-1",
      name: "spawn_agent",
      arguments: JSON.stringify({ message: "hello" }),
    }]);
    assert.equal(recorded.updates.length, 0);
    assert.equal(recorded.inspects.length, 2);
    assert.equal(recorded.inspects[0]?.kind, "tool");
    assert.equal(recorded.inspects[0]?.presentation.summary, "*Start Agent*  _hello_");
    assert.equal(recorded.inspects[0]?.output, undefined);
    assert.equal(recorded.inspects[1]?.kind, "tool");
    assert.equal(recorded.inspects[1]?.presentation.summary, "*Start Agent*  _hello_");
    assert.equal(recorded.inspects[1]?.output, "agent-pass-2");
  });

  it("wires inspect for structured MCP tool results", async () => {
    const recorded = createRecordedHandle("tool-msg-2");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async () => {
          return recorded.handle;
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "tool-2",
                  type: "mcp_tool_call",
                  server: "functions",
                  tool: "update_plan",
                  arguments: {
                    plan: [{ step: "Do work", status: "completed" }],
                  },
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "tool-2",
                  type: "mcp_tool_call",
                  server: "functions",
                  tool: "update_plan",
                  arguments: {
                    plan: [{ step: "Do work", status: "completed" }],
                  },
                  result: {
                    content: [],
                    structured_content: {
                      output: "Plan updated",
                    },
                  },
                  status: "completed",
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;
    assert.equal(recorded.updates.length, 0);
    assert.equal(recorded.inspects.length, 2);
    assert.equal(recorded.inspects[0]?.kind, "tool");
    assert.equal(recorded.inspects[0]?.presentation.summary, "*Plan*  _All 1 step completed_");
    assert.equal(recorded.inspects[0]?.output, undefined);
    assert.equal(recorded.inspects[1]?.kind, "tool");
    assert.equal(recorded.inspects[1]?.presentation.summary, "*Plan*  _All 1 step completed_");
    assert.equal(recorded.inspects[1]?.output, "Plan updated");
  });

  it("wires inspect for structured web tool results without text fields", async () => {
    const recorded = createRecordedHandle("tool-msg-web-1");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "What is UTC+00:00?",
      messages: [{ role: "user", content: [{ type: "text", text: "What is UTC+00:00?" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async () => {
          return recorded.handle;
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "tool-web-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "search_query",
                  arguments: {
                    search_query: [{ q: "UTC+00:00" }],
                  },
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "tool-web-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "search_query",
                  arguments: {
                    search_query: [{ q: "UTC+00:00" }],
                  },
                  result: {
                    content: [],
                    structured_content: {
                      results: [
                        {
                          title: "UTC+00:00 - Wikipedia",
                          url: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
                          snippet: "UTC+00:00 is an identifier for a time offset from UTC of +00:00.",
                        },
                      ],
                    },
                  },
                  status: "completed",
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;
    assert.deepEqual(
      recorded.updates.map((update) => update.kind === "tool_flow" ? formatToolFlowSummary(update.state) : ""),
      ["*Web*  search \"UTC+00:00\""],
    );
    assert.equal(recorded.inspects.length, 2);
    assert.equal(recorded.inspects.at(-1)?.kind, "tool_flow");
    assert.equal(recorded.inspects.at(-1)?.state.steps.length, 1);
    assert.ok(recorded.inspects.at(-1)?.state.steps[0]?.output?.includes("\"UTC+00:00 - Wikipedia\""));
    assert.ok(recorded.inspects.at(-1)?.state.steps[0]?.output?.includes("\"UTC+00:00 is an identifier for a time offset from UTC of +00:00.\""));
  });

  it("formats structured finance tool results readably in inspect", async () => {
    const recorded = createRecordedHandle("tool-msg-finance-1");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Check AMD",
      messages: [{ role: "user", content: [{ type: "text", text: "Check AMD" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async () => {
          return recorded.handle;
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "tool-finance-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "finance",
                  arguments: {
                    finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
                  },
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "tool-finance-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "finance",
                  arguments: {
                    finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
                  },
                  result: {
                    content: [],
                    structured_content: [
                      {
                        ticker: "AMD",
                        price: 227.45,
                        currency: "USD",
                        market: "USA",
                        change: 3.14,
                        change_percent: 1.4,
                      },
                    ],
                  },
                  status: "completed",
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;
    assert.equal(recorded.updates.length, 0);
    assert.equal(recorded.inspects.length, 2);
    assert.equal(recorded.inspects[0]?.kind, "tool");
    assert.equal(recorded.inspects[0]?.presentation.summary, "*Quote*  `AMD`");
    assert.equal(recorded.inspects[0]?.output, undefined);
    assert.equal(recorded.inspects[1]?.kind, "tool");
    assert.equal(recorded.inspects[1]?.presentation.summary, "*Quote*  `AMD`");
    assert.ok(recorded.inspects[1]?.output?.includes("\"ticker\": \"AMD\""));
    assert.ok(recorded.inspects[1]?.output?.includes("\"price\": 227.45"));
  });

  it("suppresses web-tool narration and groups related web actions into one inspectable handle", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {string[]} */
    const assistantMessages = [];
    const recorded = createRecordedHandle("tool-msg-web-group-1");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "What is UTC+00:00?",
      messages: [{ role: "user", content: [{ type: "text", text: "What is UTC+00:00?" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          return recorded.handle;
        },
        onLlmResponse: async (text) => {
          assistantMessages.push(text);
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.completed",
                item: {
                  id: "msg-1",
                  type: "agent_message",
                  text: "Using the `web` tool now for a minimal search request in this pass.",
                },
              };
              yield {
                type: "item.started",
                item: {
                  id: "web-search-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "search_query",
                  arguments: {
                    search_query: [{ q: "UTC+00:00" }],
                  },
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "web-search-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "search_query",
                  arguments: {
                    search_query: [{ q: "UTC+00:00" }],
                  },
                  result: {
                    content: [],
                    structured_content: {
                      results: [
                        {
                          title: "UTC+00:00 - Wikipedia",
                          url: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
                          snippet: "UTC+00:00 is an identifier for a time offset from UTC of +00:00.",
                        },
                      ],
                    },
                  },
                  status: "completed",
                },
              };
              yield {
                type: "item.started",
                item: {
                  id: "web-open-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "open",
                  arguments: {
                    ref_id: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
                  },
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "web-open-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "open",
                  arguments: {
                    ref_id: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
                  },
                  result: {
                    content: [],
                    structured_content: {
                      title: "UTC+00:00 - Wikipedia",
                      url: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
                      excerpt: "UTC+00:00 is an identifier for a time offset from UTC of +00:00.",
                    },
                  },
                  status: "completed",
                },
              };
              yield {
                type: "item.started",
                item: {
                  id: "web-find-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "find",
                  arguments: {
                    ref_id: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
                    pattern: "UTC+00:00 is an identifier for a time offset from UTC of +00:00.",
                  },
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "web-find-1",
                  type: "mcp_tool_call",
                  server: "web",
                  tool: "find",
                  arguments: {
                    ref_id: "https://en.wikipedia.org/wiki/UTC%2B00%3A00",
                    pattern: "UTC+00:00 is an identifier for a time offset from UTC of +00:00.",
                  },
                  result: {
                    content: [],
                    structured_content: {
                      matches: [
                        {
                          text: "UTC+00:00 is an identifier for a time offset from UTC of +00:00.",
                        },
                      ],
                    },
                  },
                  status: "completed",
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(assistantMessages, []);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.name, "search_query");
    assert.deepEqual(
      recorded.updates.map((update) => update.kind === "tool_flow" ? formatToolFlowSummary(update.state) : ""),
      [
        "*Web*  search \"UTC+00:00\"",
        "*Web*  search \"UTC+00:00\" -> open `en.wikipedia.org/wiki/UTC%2B00%3A00`",
        "*Web*  search \"UTC+00:00\" -> open `en.wikipedia.org/wiki/UTC%2B00%3A00` -> find \"UTC+00:00 is an identifier for a time offset from UTC of +00:00.\"",
      ],
    );
    assert.equal(recorded.inspects.at(-1)?.kind, "tool_flow");
    assert.equal(recorded.inspects.at(-1)?.state.steps.length, 3);
    assert.ok(recorded.inspects.at(-1)?.state.steps[0]?.output?.includes("\"UTC+00:00 - Wikipedia\""));
    assert.ok(recorded.inspects.at(-1)?.state.steps[1]?.output?.includes("\"excerpt\": \"UTC+00:00 is an identifier for a time offset from UTC of +00:00.\""));
    assert.ok(recorded.inspects.at(-1)?.state.steps[2]?.output?.includes("\"matches\""));
  });

  it("surfaces todo_list items as update_plan tool calls", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    const recorded = createRecordedHandle("tool-msg-3");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          return recorded.handle;
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "todo-1",
                  type: "todo_list",
                  items: [
                    { text: "Initialize requested plan state", completed: true },
                  ],
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "todo-1",
                  type: "todo_list",
                  items: [
                    { text: "Initialize requested plan state", completed: true },
                  ],
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(toolCalls, [{
      id: "todo-1",
      name: "update_plan",
      arguments: JSON.stringify({
        items: [
          { text: "Initialize requested plan state", completed: true },
        ],
      }),
    }]);
    assert.equal(recorded.inspects.length, 2);
    assert.equal(recorded.inspects.at(-1)?.kind, "tool");
    assert.equal(recorded.inspects.at(-1)?.presentation.kind, "plan");
    assert.deepEqual(recorded.inspects.at(-1)?.presentation.entries, [
      { text: "Initialize requested plan state", status: "completed" },
    ]);
    assert.equal(recorded.inspects.at(-1)?.output, "Initialize requested plan state");
  });

  it("keeps the first update_plan message inspectable before completion", async () => {
    const recorded = createRecordedHandle("tool-msg-plan-start");

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async () => {
          return recorded.handle;
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "todo-start-1",
                  type: "todo_list",
                  items: [
                    { text: "Inspectable immediately", completed: false },
                    { text: "Not finished yet", completed: false },
                  ],
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;
    assert.equal(recorded.inspects.length, 1);
    assert.equal(recorded.inspects[0]?.kind, "tool");
    assert.equal(recorded.inspects[0]?.presentation.kind, "plan");
    assert.deepEqual(recorded.inspects[0]?.presentation.entries, [
      { text: "Inspectable immediately", status: "pending" },
      { text: "Not finished yet", status: "pending" },
    ]);
  });

  it("creates a synthetic write_stdin tool call from announced Codex activity", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {ReturnType<typeof createRecordedHandle>[]} */
    const handles = [];

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          const recorded = createRecordedHandle(`tool-msg-${toolCalls.length}`);
          handles.push(recorded);
          return recorded.handle;
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.completed",
                item: {
                  id: "msg-1",
                  type: "agent_message",
                  text: "Using `write_stdin` now to send text through the live session.",
                },
              };
              yield {
                type: "item.started",
                item: {
                  id: "cmd-1",
                  type: "command_execution",
                  command: "/bin/zsh -lc cat",
                  aggregated_output: "",
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "cmd-1",
                  type: "command_execution",
                  command: "/bin/zsh -lc cat",
                  aggregated_output: "hello\r\nhello\r\n",
                  exit_code: 0,
                  status: "completed",
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await started.done;

    assert.deepEqual(toolCalls.map((toolCall) => toolCall.name), ["write_stdin"]);
    assert.equal(handles.length, 1);
    assert.equal(handles[0].inspects.length, 1);
    assert.equal(handles[0].inspects[0]?.kind, "tool");
    assert.equal(handles[0].inspects[0]?.presentation.summary, "*Terminal Input*");
    assert.equal(handles[0].inspects[0]?.output, "hello\r\nhello\r\n");
  });

  it("asks for approval and retries with an additional writable directory", async () => {
    /** @type {import("@openai/codex-sdk").ThreadOptions[]} */
    const observedOptions = [];
    /** @type {string[]} */
    const prompts = [];
    /** @type {string[]} */
    const errors = [];

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo/project",
        sandboxMode: "workspace-write",
      },
      hooks: {
        onAskUser: async (question, options) => {
          prompts.push(question);
          assert.deepEqual(options, ["✅ Allow", "❌ Deny"]);
          return "✅ Allow";
        },
        onToolError: async (message) => {
          errors.push(message);
        },
      },
    }, {
      createCodex: () => ({
        startThread: (threadOptions) => {
          observedOptions.push(threadOptions ?? {});
          return {
            id: "sess-123",
            runStreamed: async () => ({
              events: (async function* () {
                yield {
                  type: "item.started",
                  item: {
                    id: "cmd-1",
                    type: "command_execution",
                    command: "mkdir -p ../shared",
                    aggregated_output: "",
                    status: "in_progress",
                  },
                };
              })(),
            }),
          };
        },
        resumeThread: (id, threadOptions) => {
          assert.equal(id, "sess-123");
          observedOptions.push(threadOptions ?? {});
          return {
            id,
            runStreamed: async () => ({
              events: (async function* () {
                yield {
                  type: "item.completed",
                  item: {
                    id: "msg-1",
                    type: "agent_message",
                    text: "Applied fix after approval",
                  },
                };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 3,
                    output_tokens: 2,
                    cached_input_tokens: 0,
                  },
                };
              })(),
            }),
          };
        },
      }),
    });

    const completed = await started.done;

    assert.equal(errors.length, 0);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Sandbox escape request/);
    assert.deepEqual(observedOptions, [
      {
        workingDirectory: "/repo/project",
        sandboxMode: "workspace-write",
        skipGitRepoCheck: true,
      },
      {
        workingDirectory: "/repo/project",
        sandboxMode: "workspace-write",
        additionalDirectories: ["/repo/shared"],
        skipGitRepoCheck: true,
      },
    ]);
    assert.equal(completed.sessionId, "sess-123");
    assert.deepEqual(completed.result.response, [{ type: "markdown", text: "Applied fix after approval" }]);
  });

  it("fails cleanly when sandbox escape approval is denied", async () => {
    /** @type {string[]} */
    const prompts = [];
    /** @type {string[]} */
    const errors = [];

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo/project",
        sandboxMode: "workspace-write",
      },
      hooks: {
        onAskUser: async (question) => {
          prompts.push(question);
          return "❌ Deny";
        },
        onToolError: async (message) => {
          errors.push(message);
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "cmd-1",
                  type: "command_execution",
                  command: "touch ../shared/out.txt",
                  aggregated_output: "",
                  status: "in_progress",
                },
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await assert.rejects(started.done, /Sandbox escape denied for `\/repo\/shared`/);
    assert.equal(prompts.length, 1);
    assert.deepEqual(errors, ["Sandbox escape denied for `/repo/shared`"]);
  });

  it("reports Codex SDK failures that happen before event streaming starts", async () => {
    /** @type {string[]} */
    const errors = [];

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {
        onToolError: async (message) => {
          errors.push(message);
        },
      },
    }, {
      createCodex: () => ({
        startThread: () => ({
          id: "sess-123",
          runStreamed: async () => {
            throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...");
          },
        }),
        resumeThread: () => {
          throw new Error("resumeThread should not be called");
        },
      }),
    });

    await assert.rejects(started.done, /Codex Exec exited with code 1: Reading prompt from stdin/);
    assert.deepEqual(errors, ["Codex Exec exited with code 1: Reading prompt from stdin..."]);
  });
});
