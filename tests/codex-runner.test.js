import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { startCodexRun } from "../harnesses/codex-runner.js";

/**
 * @typedef {EventEmitter & {
 *   stdin: PassThrough,
 *   stdout: PassThrough,
 *   stderr: PassThrough,
 *   kill: (signal?: NodeJS.Signals | number) => boolean,
 * }} FakeCodexChild
 */

/**
 * @returns {FakeCodexChild}
 */
function createFakeCodexChild() {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: () => true,
  });

  return child;
}

describe("startCodexRun", () => {
  it("returns streamed assistant text when the final output file is unavailable", async () => {
    const child = createFakeCodexChild();
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
    /** @type {string[]} */
    const prompts = [];

    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      prompts.push(chunk);
    });

    const started = await startCodexRun({
      chatId: "codex-chat",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
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
      spawn: () => child,
      mkdtemp: async () => "/tmp/codex-harness-test",
      readFile: async () => {
        throw new Error("missing final output");
      },
      rm: async () => {},
      createInterface,
      tmpdir: () => "/tmp",
    });

    child.stdout.write(`${JSON.stringify({
      thread_id: "sess-123",
      type: "item.started",
      item: { type: "command_execution", command: "pnpm type-check" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "item.completed",
      item: { type: "plan_update", content: [{ text: "Step 1" }, { text: "Step 2" }] },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "item.completed",
      item: { type: "file_patch", path: "src/app.js", summary: "Updated app" },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", content: [{ text: "Applied fix" }] },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "turn.completed",
      input_tokens: 11,
      output_tokens: 7,
      cached_input_tokens: 3,
    })}\n`);
    child.stdout.end();
    child.emit("close", 0);

    const result = await started.done;

    assert.equal(prompts.join(""), "Continue");
    assert.equal(result.sessionId, "sess-123");
    assert.deepEqual(commands, ["started:pnpm type-check"]);
    assert.deepEqual(plans, ["Step 1\nStep 2"]);
    assert.deepEqual(fileChanges, [{ path: "src/app.js", summary: "Updated app" }]);
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
