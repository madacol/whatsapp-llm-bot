import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodexThreadOptions, buildCodexTurnInput, startCodexRun } from "../harnesses/codex-runner.js";

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

  it("surfaces mcp tool calls and wires inspect for text results", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {string[]} */
    const edits = [];
    /** @type {ReactionCallback | null} */
    let reactionCallback = null;

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
          return /** @type {MessageHandle} */ ({
            keyId: "tool-msg-1",
            isImage: false,
            edit: async (text) => {
              edits.push(text);
            },
            onReaction: (callback) => {
              reactionCallback = callback;
              return () => {};
            },
          });
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

    reactionCallback?.("👁", "user-1");
    assert.deepEqual(edits, [[
      "*spawn_agent*",
      "",
      "agent-pass-2",
    ].join("\n")]);
  });

  it("wires inspect for structured MCP tool results", async () => {
    /** @type {string[]} */
    const edits = [];
    /** @type {ReactionCallback | null} */
    let reactionCallback = null;

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async () => {
          return /** @type {MessageHandle} */ ({
            keyId: "tool-msg-2",
            isImage: false,
            edit: async (text) => {
              edits.push(text);
            },
            onReaction: (callback) => {
              reactionCallback = callback;
              return () => {};
            },
          });
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

    reactionCallback?.("👁", "user-1");
    assert.deepEqual(edits, [[
      "*Plan*  _1 step_",
      "",
      "[x] Do work",
      "",
      "Plan updated",
    ].join("\n")]);
  });

  it("surfaces todo_list items as update_plan tool calls", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {string[]} */
    const edits = [];
    /** @type {ReactionCallback | null} */
    let reactionCallback = null;

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
          return /** @type {MessageHandle} */ ({
            keyId: "tool-msg-3",
            isImage: false,
            edit: async (text) => {
              edits.push(text);
            },
            onReaction: (callback) => {
              reactionCallback = callback;
              return () => {};
            },
          });
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

    reactionCallback?.("👁", "user-1");
    assert.deepEqual(edits, [[
      "*Plan*  _1 step_",
      "",
      "[x] Initialize requested plan state",
    ].join("\n")]);
  });

  it("keeps the first update_plan message inspectable before completion", async () => {
    /** @type {string[]} */
    const edits = [];
    /** @type {ReactionCallback | null} */
    let reactionCallback = null;

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onToolCall: async () => {
          return /** @type {MessageHandle} */ ({
            keyId: "tool-msg-plan-start",
            isImage: false,
            edit: async (text) => {
              edits.push(text);
            },
            onReaction: (callback) => {
              reactionCallback = callback;
              return () => {};
            },
          });
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

    reactionCallback?.("👁", "user-1");
    assert.deepEqual(edits, [[
      "*Plan*  _2 steps_",
      "",
      "[ ] Inspectable immediately",
      "[ ] Not finished yet",
    ].join("\n")]);
  });

  it("creates a synthetic write_stdin tool call from announced Codex activity", async () => {
    /** @type {LlmChatResponse["toolCalls"]} */
    const toolCalls = [];
    /** @type {string[]} */
    const edits = [];
    /** @type {ReactionCallback[]} */
    const reactions = [];

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
          return /** @type {MessageHandle} */ ({
            keyId: `tool-msg-${toolCalls.length}`,
            isImage: false,
            edit: async (text) => {
              edits.push(text);
            },
            onReaction: (callback) => {
              reactions.push(callback);
              return () => {};
            },
          });
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
    reactions[0]?.("👁", "user-1");
    assert.deepEqual(edits, [[
      "*write_stdin*",
      "",
      "hello\r\nhello\r\n",
    ].join("\n")]);
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
});
