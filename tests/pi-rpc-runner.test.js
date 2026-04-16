import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPiRpcRun } from "../harnesses/pi-runner.js";

/**
 * @typedef {{
 *   signal?: AbortSignal,
 *   notifications?: Array<Record<string, unknown>>,
 * }} OpenConnectionOptions
 */

/**
 * @returns {{
 *   sendRequests: Array<Record<string, unknown>>,
 *   openConnection: (options?: OpenConnectionOptions) => Promise<{
 *     sendRequest: (message: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *     notifications: AsyncGenerator<Record<string, unknown>>,
 *     close: () => Promise<void>,
 *   }>,
 * }}
 */
function createOpenConnectionMock() {
  /** @type {Array<Record<string, unknown>>} */
  const sendRequests = [];

  return {
    sendRequests,
    async openConnection(options = {}) {
      const notifications = options.notifications ?? [
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Inspecting the codebase.",
          },
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Inspecting the codebase." }],
          },
        },
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
              usage: {
                input: 120,
                output: 34,
                cacheRead: 5,
                cost: { total: 0.123 },
              },
            },
          ],
        },
      ];

      return {
        async sendRequest(message) {
          sendRequests.push(message);
          switch (message.type) {
            case "switch_session":
              return {
                type: "response",
                command: "switch_session",
                success: true,
                data: { cancelled: false },
              };
            case "get_available_models":
              return {
                type: "response",
                command: "get_available_models",
                success: true,
                data: {
                  models: [
                    {
                      id: "gemini-2.5-pro",
                      name: "Gemini 2.5 Pro",
                      provider: "google",
                      reasoning: true,
                    },
                  ],
                },
              };
            case "set_model":
              return {
                type: "response",
                command: "set_model",
                success: true,
                data: {
                  id: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                  provider: "google",
                },
              };
            case "set_thinking_level":
              return {
                type: "response",
                command: "set_thinking_level",
                success: true,
              };
            case "prompt":
              return {
                type: "response",
                command: "prompt",
                success: true,
              };
            case "get_state":
              return {
                type: "response",
                command: "get_state",
                success: true,
                data: {
                  sessionFile: "/tmp/pi-session-1.jsonl",
                  sessionId: "sess-1",
                  isStreaming: false,
                },
              };
            default:
              return {
                type: "response",
                command: typeof message.type === "string" ? message.type : "unknown",
                success: true,
              };
          }
        },
        notifications: (async function* () {
          for (const notification of notifications) {
            yield notification;
          }
        })(),
        close: async () => {},
      };
    },
  };
}

describe("startPiRpcRun", () => {
  it("switches sessions, applies model config, and persists the resulting session file", async () => {
    const connectionMock = createOpenConnectionMock();
    /** @type {Array<Record<string, unknown>>} */
    const reasoningEvents = [];

    const started = await startPiRpcRun({
      chatId: "pi-chat-1",
      prompt: "Inspect the bug",
      externalInstructions: "Keep changes minimal.",
      messages: [{ role: "user", content: [{ type: "text", text: "Inspect the bug" }] }],
      sessionPath: "/tmp/pi-parent.jsonl",
      runConfig: {
        workdir: "/repo/project",
        model: "google/gemini-2.5-pro",
        reasoningEffort: "high",
      },
      hooks: {
        onReasoning: async (event) => {
          reasoningEvents.push(event);
        },
      },
    }, {
      openConnection: connectionMock.openConnection,
    });

    const completed = await started.done;

    assert.deepEqual(connectionMock.sendRequests.map((message) => message.type), [
      "switch_session",
      "get_available_models",
      "set_model",
      "set_thinking_level",
      "prompt",
      "get_state",
    ]);
    assert.deepEqual(connectionMock.sendRequests[0], {
      id: "req-1",
      type: "switch_session",
      sessionPath: "/tmp/pi-parent.jsonl",
    });
    assert.deepEqual(connectionMock.sendRequests[2], {
      id: "req-3",
      type: "set_model",
      provider: "google",
      modelId: "gemini-2.5-pro",
    });
    assert.deepEqual(connectionMock.sendRequests[3], {
      id: "req-4",
      type: "set_thinking_level",
      level: "high",
    });
    assert.deepEqual(connectionMock.sendRequests[4], {
      id: "req-5",
      type: "prompt",
      message: [
        "Follow these instructions for this run:",
        "Keep changes minimal.",
        "",
        "User request:",
        "Inspect the bug",
      ].join("\n"),
    });

    assert.deepEqual(reasoningEvents, [{
      status: "updated",
      summaryParts: [],
      contentParts: ["Inspecting the codebase."],
      text: "Inspecting the codebase.",
    }]);
    assert.equal(completed.sessionPath, "/tmp/pi-session-1.jsonl");
    assert.deepEqual(completed.result.response, [{ type: "markdown", text: "Done." }]);
    assert.deepEqual(completed.result.usage, {
      promptTokens: 120,
      completionTokens: 34,
      cachedTokens: 5,
      cost: 0.123,
    });
  });
});
