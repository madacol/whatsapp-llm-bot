import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodexThreadOptions, startCodexRun } from "../harnesses/codex-runner.js";

describe("buildCodexThreadOptions", () => {
  it("maps shared run config to Codex SDK thread options", () => {
    assert.deepEqual(buildCodexThreadOptions({
      workdir: "/repo",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    }), {
      workingDirectory: "/repo",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
  });
});

describe("startCodexRun", () => {
  it("returns streamed assistant text from SDK events", async () => {
    /** @type {string[]} */
    const commands = [];
    /** @type {string[]} */
    const plans = [];
    /** @type {Array<{ path: string, summary?: string }>} */
    const fileChanges = [];
    /** @type {string[]} */
    const assistantMessages = [];
    /** @type {Array<{ cost: string, tokens: { prompt: number, completion: number, cached: number } }>} */
    const usageEvents = [];

    /** @type {import("@openai/codex-sdk").ThreadEvent[]} */
    const events = [
      { type: "thread.started", thread_id: "sess-123" },
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "pnpm type-check",
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
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
        model: "gpt-5.4",
      },
      hooks: {
        onCommand: async ({ command, status }) => {
          commands.push(`${status}:${command}`);
        },
        onPlan: async (text) => {
          plans.push(text);
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

    assert.equal(observed.prompt, "Continue");
    assert.deepEqual(observed.threadOptions, {
      workingDirectory: "/repo",
      model: "gpt-5.4",
      skipGitRepoCheck: true,
    });
    assert.equal(observed.signalAborted, false);
    assert.equal(result.sessionId, "sess-123");
    assert.deepEqual(commands, ["started:pnpm type-check"]);
    assert.deepEqual(plans, ["Step 1\nStep 2"]);
    assert.deepEqual(fileChanges, [{ path: "src/app.js", summary: "src/app.js (update)" }]);
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
});
