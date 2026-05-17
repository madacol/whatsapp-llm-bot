import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessRuntimeEventDispatcher } from "../harnesses/harness-runtime-event-dispatcher.js";

describe("createHarnessRuntimeEventDispatcher", () => {
  it("projects canonical runtime events into hooks and result state", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];
    /** @type {string[]} */
    const responses = [];
    /** @type {Array<{ cost: string, tokens: UsageTokens }>} */
    const usageEvents = [];
    let composingCount = 0;
    let pausedCount = 0;

    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [{ role: "user", content: [{ type: "text", text: "Ship it" }] }],
      hooks: {
        onComposing: async () => {
          composingCount += 1;
        },
        onPaused: async () => {
          pausedCount += 1;
        },
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
        onLlmResponse: async (text) => {
          responses.push(text);
        },
        onUsage: async (cost, tokens) => {
          usageEvents.push({ cost, tokens });
        },
      },
    });

    await dispatcher.handleEvent({
      type: "reasoning.updated",
      provider: "pi",
      text: "Reading files.",
      status: "updated",
      raw: { type: "message_update" },
    });
    await dispatcher.handleEvent({
      type: "assistant.completed",
      provider: "pi",
      text: "Done.",
      contentType: "markdown",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 2,
        cost: 0.0123,
      },
    });

    assert.deepEqual(reasoningEvents, [{
      status: "updated",
      summaryParts: [],
      contentParts: ["Reading files."],
      text: "Reading files.",
    }]);
    assert.deepEqual(responses, ["Done."]);
    assert.deepEqual(dispatcher.result.response, [{ type: "markdown", text: "Done." }]);
    assert.deepEqual(dispatcher.result.usage, {
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 2,
      cost: 0.0123,
    });
    assert.deepEqual(usageEvents, [{
      cost: "0.012300",
      tokens: {
        prompt: 10,
        completion: 5,
        cached: 2,
      },
    }]);
    assert.equal(composingCount, 0);
    assert.equal(pausedCount, 0);
  });

  it("tracks generic tool lifecycle events for inspect updates", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const toolCalls = [];
    /** @type {Array<MessageInspectState | null>} */
    const inspectStates = [];
    let composingCount = 0;
    let pausedCount = 0;

    const dispatcher = createHarnessRuntimeEventDispatcher({
      provider: "pi",
      messages: [],
      workdir: "/repo",
      hooks: {
        onComposing: async () => {
          composingCount += 1;
        },
        onPaused: async () => {
          pausedCount += 1;
        },
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
          return {
            keyId: "msg-1",
            isImage: false,
            update: async () => {},
            setInspect: (state) => {
              inspectStates.push(state);
            },
          };
        },
      },
    });

    await dispatcher.handleEvent({
      type: "tool.started",
      provider: "pi",
      tool: {
        id: "tool-1",
        name: "Read",
        arguments: { file_path: "README.md" },
      },
    });
    await dispatcher.handleEvent({
      type: "tool.updated",
      provider: "pi",
      tool: {
        id: "tool-1",
        name: "Read",
        arguments: { file_path: "README.md" },
        output: "partial",
      },
    });
    await dispatcher.handleEvent({
      type: "tool.completed",
      provider: "pi",
      tool: {
        id: "tool-1",
        name: "Read",
        arguments: { file_path: "README.md" },
        output: "final",
      },
    });

    assert.deepEqual(toolCalls, [{
      id: "tool-1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "README.md" }),
    }]);
    assert.equal(pausedCount, 1);
    assert.equal(composingCount, 1);
    assert.equal(inspectStates.length, 2);
    assert.equal(inspectStates.at(-1)?.kind, "tool");
    assert.equal(
      inspectStates.at(-1)?.kind === "tool" ? inspectStates.at(-1)?.output : null,
      "final",
    );
  });
});
