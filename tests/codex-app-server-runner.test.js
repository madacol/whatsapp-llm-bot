import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startCodexAppServerRun } from "../harnesses/codex-app-server-runner.js";
import {
  buildCodexAppServerSandboxPolicy,
  handleCodexAppServerRequest,
  mapCodexAppServerApprovalPolicy,
} from "../harnesses/codex-app-server-protocol.js";

/**
 * @typedef {{
 *   handleRequest?: (message: Record<string, unknown>) => Promise<unknown>,
 *   signal?: AbortSignal,
 *   notifications?: Array<Record<string, unknown>>,
 * }} OpenConnectionOptions
 */

/**
 * @returns {{
 *   sendRequests: Array<{ method: string, params: Record<string, unknown> }>,
 *   getHandleRequest: () => ((message: Record<string, unknown>) => Promise<unknown>) | null,
 *   openConnection: (options?: OpenConnectionOptions) => Promise<{
 *     sendRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
 *     notifications: AsyncGenerator<Record<string, unknown>>,
 *     close: () => Promise<void>,
 *   }>,
 * }}
 */
function createOpenConnectionMock() {
  /** @type {Array<{ method: string, params: Record<string, unknown> }>} */
  const sendRequests = [];
  /** @type {((message: Record<string, unknown>) => Promise<unknown>) | null} */
  let handleRequest = null;

  return {
    sendRequests,
    getHandleRequest: () => handleRequest,
    async openConnection(options = {}) {
      handleRequest = options.handleRequest ?? null;
      const notifications = options.notifications ?? [{
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            error: null,
          },
        },
      }];
      return {
        async sendRequest(method, params = {}) {
          sendRequests.push({ method, params });
          if (method === "thread/start") {
            return { thread: { id: "thread-1" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          return {};
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

/**
 * @returns {{
 *   notifications: AsyncGenerator<Record<string, unknown>>,
 *   push: (notification: Record<string, unknown>) => void,
 *   end: () => void,
 * }}
 */
function createNotificationController() {
  /** @type {Record<string, unknown>[]} */
  const values = [];
  /** @type {Array<(value: Record<string, unknown> | null) => void>} */
  const waiters = [];
  let ended = false;

  /**
   * @param {Record<string, unknown> | null} value
   * @returns {void}
   */
  function deliver(value) {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(value);
    } else if (value) {
      values.push(value);
    }
  }

  return {
    notifications: (async function* () {
      while (true) {
        const next = values.shift() ?? (ended ? null : await new Promise((resolve) => {
          waiters.push(resolve);
        }));
        if (!next) {
          return;
        }
        yield next;
      }
    })(),
    push(notification) {
      if (!ended) {
        deliver(notification);
      }
    },
    end() {
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()?.(null);
      }
    },
  };
}

describe("startCodexAppServerRun", () => {
  it("emits image generation lifecycle events and final image content from app-server notifications", async () => {
    const connectionMock = createOpenConnectionMock();
    /** @type {Array<{ id: string, name: string, arguments: string }>} */
    const toolCalls = [];
    /** @type {Array<{ id: string, name: string, arguments: string }>} */
    const toolCompletes = [];
    /** @type {ToolContentBlock[][]} */
    const toolResults = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-image-gen",
      prompt: "Generate an image",
      messages: [{ role: "user", content: [{ type: "text", text: "Generate an image" }] }],
      hooks: {
        onToolCall: async (toolCall) => {
          toolCalls.push(toolCall);
        },
        onToolComplete: async (toolCall) => {
          toolCompletes.push(toolCall);
        },
        onToolResult: async (blocks) => {
          toolResults.push(blocks);
        },
      },
    }, {
      openConnection: (options = {}) => connectionMock.openConnection({
        ...options,
        notifications: [
          {
            method: "item/started",
            params: {
              threadId: "thread-1",
              item: {
                id: "ig_1",
                type: "imageGeneration",
                status: "in_progress",
                revisedPrompt: null,
                result: "",
              },
            },
          },
          {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              item: {
                id: "ig_1",
                type: "imageGeneration",
                status: "generating",
                result: "iVBORw0KGgo=",
                savedPath: "/home/mada/.codex/generated_images/thread-1/ig_1.png",
              },
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          },
        ],
      }),
    });

    const completed = await started.done;
    const imageBlock = /** @type {ToolContentBlock} */ ({
      type: "image",
      mime_type: "image/png",
      encoding: "base64",
      data: "iVBORw0KGgo=",
    });

    assert.deepEqual(toolCalls, [{
      id: "ig_1",
      name: "image_gen",
      arguments: "{}",
    }]);
    assert.deepEqual(toolCompletes, [{
      id: "ig_1",
      name: "image_gen",
      arguments: "{}",
    }]);
    assert.deepEqual(toolResults, [[imageBlock]]);
    assert.deepEqual(completed.result.response, [imageBlock]);
  });

  it("logs app-server notifications that have no semantic handler", async () => {
    const connectionMock = createOpenConnectionMock();
    /** @type {unknown[][]} */
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args);
    };

    try {
      const started = await startCodexAppServerRun({
        chatId: "chat-unhandled",
        prompt: "Continue",
        messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      }, {
        openConnection: (options = {}) => connectionMock.openConnection({
          ...options,
          notifications: [
            {
              method: "mcpServer/startupStatus/updated",
              params: {
                threadId: "thread-1",
                serverName: "filesystem",
                status: "ready",
              },
            },
            {
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                },
              },
            },
          ],
        }),
      });

      await started.done;
    } finally {
      console.log = originalLog;
    }

    assert.ok(logs.some(([message, details]) => (
      message === "[codex:app-server] Unhandled event"
      && typeof details === "object"
      && details !== null
      && "method" in details
      && details.method === "mcpServer/startupStatus/updated"
      && "status" in details
      && details.status === "ready"
    )), `Expected unhandled app-server event log, got ${JSON.stringify(logs)}`);
  });

  it("estimates Codex app-server usage cost from token usage updates", async () => {
    const connectionMock = createOpenConnectionMock();
    /** @type {Array<{ cost: string, tokens: UsageTokens }>} */
    const usageEvents = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-usage",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        model: "gpt-5.3-codex",
      },
      hooks: {
        onUsage: async (cost, tokens) => {
          usageEvents.push({ cost, tokens });
        },
      },
    }, {
      openConnection: (options = {}) => connectionMock.openConnection({
        ...options,
        notifications: [
          {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              tokenUsage: {
                total: {
                  totalTokens: 114772,
                  inputTokens: 114529,
                  cachedInputTokens: 111488,
                  outputTokens: 243,
                  reasoningOutputTokens: 12,
                },
                modelContextWindow: 400000,
              },
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          },
        ],
      }),
    });

    const completed = await started.done;

    assert.deepEqual(completed.result.usage, {
      promptTokens: 114529,
      completionTokens: 243,
      cachedTokens: 111488,
      totalTokens: 114772,
      reasoningTokens: 12,
      contextWindow: 400000,
      cost: 0.02823415,
    });
    assert.deepEqual(usageEvents, [{
      cost: "0.028234",
      tokens: {
        prompt: 114529,
        completion: 243,
        cached: 111488,
        total: 114772,
        reasoning: 12,
        contextWindow: 400000,
      },
    }]);
  });

  it("retries a transient startup connection close before reporting failure", async () => {
    let openAttempts = 0;
    /** @type {Array<{ method: string, params: Record<string, unknown> }>} */
    const sendRequests = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      sessionId: "thread-existing",
    }, {
      openConnection: async () => {
        openAttempts += 1;
        if (openAttempts === 1) {
          throw new Error("Connection Closed");
        }
        return {
          async sendRequest(method, params = {}) {
            sendRequests.push({ method, params });
            if (method === "thread/resume") {
              return { thread: { id: "thread-existing" } };
            }
            if (method === "turn/start") {
              return { turn: { id: "turn-1" } };
            }
            return {};
          },
          notifications: (async function* () {
            yield {
              method: "turn/completed",
              params: {
                threadId: "thread-existing",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                },
              },
            };
          })(),
          close: async () => {},
        };
      },
    });

    const completed = await started.done;

    assert.equal(openAttempts, 2);
    assert.equal(completed.sessionId, "thread-existing");
    assert.deepEqual(sendRequests.map((request) => request.method), ["thread/resume", "turn/start"]);
  });

  it("keeps the parent session when app server reports a sub-agent thread start", async () => {
    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      sessionId: "thread-parent",
    }, {
      openConnection: async () => ({
        async sendRequest(method) {
          if (method === "thread/resume") {
            return { thread: { id: "thread-parent" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          return {};
        },
        notifications: (async function* () {
          yield {
            method: "thread/started",
            params: {
              thread: {
                id: "thread-child",
                source: {
                  subAgent: {
                    thread_spawn: {
                      parent_thread_id: "thread-parent",
                      agent_nickname: "Kierkegaard",
                    },
                  },
                },
              },
            },
          };
          yield {
            method: "turn/completed",
            params: {
              threadId: "thread-child",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          };
        })(),
        close: async () => {},
      }),
    });

    const completed = await started.done;

    assert.equal(completed.sessionId, "thread-parent");
  });

  it("routes lower-case sub-agent child messages with sub-agent metadata", async () => {
    /** @type {Array<{ text: string, metadata?: LlmResponseMetadata }>} */
    const responses = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      sessionId: "thread-parent",
      hooks: {
        onLlmResponse: async (text, metadata) => {
          responses.push({ text, ...(metadata !== undefined && { metadata }) });
        },
      },
    }, {
      openConnection: async () => ({
        async sendRequest(method) {
          if (method === "thread/resume") {
            return { thread: { id: "thread-parent" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          return {};
        },
        notifications: (async function* () {
          yield {
            method: "thread/started",
            params: {
              thread: {
                id: "thread-child",
                source: {
                  subagent: {
                    thread_spawn: {
                      parent_thread_id: "thread-parent",
                      agent_nickname: "Bernoulli",
                      agent_role: "default",
                    },
                  },
                },
              },
            },
          };
          yield {
            method: "item/completed",
            params: {
              threadId: "thread-child",
              item: {
                id: "item-child-message",
                type: "agentMessage",
                text: "SUBAGENT_QUICK_DEMO: hello from sub-agent visibility.",
              },
            },
          };
          yield {
            method: "turn/completed",
            params: {
              threadId: "thread-parent",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          };
        })(),
        close: async () => {},
      }),
    });

    const completed = await started.done;

    assert.equal(completed.sessionId, "thread-parent");
    assert.deepEqual(completed.result.response, []);
    assert.deepEqual(responses, [{
      text: "SUBAGENT_QUICK_DEMO: hello from sub-agent visibility.",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
        parentThreadId: "thread-parent",
        agentNickname: "Bernoulli",
        agentRole: "default",
      },
    }]);
  });

  it("reads sub-agent thread metadata before emitting collab sub-agent responses", async () => {
    /** @type {Array<{ text: string, metadata?: LlmResponseMetadata }>} */
    const responses = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      sessionId: "thread-parent",
      hooks: {
        onLlmResponse: async (text, metadata) => {
          responses.push({ text, ...(metadata !== undefined && { metadata }) });
        },
      },
    }, {
      openConnection: async () => ({
        async sendRequest(method, params) {
          if (method === "thread/resume") {
            return { thread: { id: "thread-parent" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          if (method === "thread/read" && params?.threadId === "thread-child") {
            return {
              thread: {
                id: "thread-child",
                agentNickname: "Heisenberg",
                agentRole: "default",
                source: {
                  subAgent: {
                    thread_spawn: {
                      parent_thread_id: "thread-parent",
                      agent_nickname: "Heisenberg",
                      agent_role: "default",
                    },
                  },
                },
              },
            };
          }
          return {};
        },
        notifications: (async function* () {
          yield {
            method: "item/completed",
            params: {
              threadId: "thread-parent",
              item: {
                id: "item-wait",
                type: "collabAgentToolCall",
                tool: "wait",
                receiverThreadIds: ["thread-child"],
                agentsStates: {
                  "thread-child": {
                    status: "completed",
                    message: "SUBAGENT_NICKNAME_VERIFY: hello from named sub-agent",
                  },
                },
                status: "completed",
              },
            },
          };
          yield {
            method: "turn/completed",
            params: {
              threadId: "thread-parent",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          };
        })(),
        close: async () => {},
      }),
    });

    await started.done;

    assert.deepEqual(responses, [{
      text: "SUBAGENT_NICKNAME_VERIFY: hello from named sub-agent",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
        parentThreadId: "thread-parent",
        agentNickname: "Heisenberg",
        agentRole: "default",
      },
    }]);
  });

  it("reads sub-agent thread metadata before emitting child thread agent messages", async () => {
    /** @type {Array<{ text: string, metadata?: LlmResponseMetadata }>} */
    const responses = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      sessionId: "thread-parent",
      hooks: {
        onLlmResponse: async (text, metadata) => {
          responses.push({ text, ...(metadata !== undefined && { metadata }) });
        },
      },
    }, {
      openConnection: async () => ({
        async sendRequest(method, params) {
          if (method === "thread/resume") {
            return { thread: { id: "thread-parent" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          if (method === "thread/read" && params?.threadId === "thread-child") {
            return {
              thread: {
                id: "thread-child",
                agentNickname: "Planck",
                agentRole: "default",
                source: {
                  subAgent: {
                    thread_spawn: {
                      parent_thread_id: "thread-parent",
                      agent_nickname: "Planck",
                      agent_role: "default",
                    },
                  },
                },
              },
            };
          }
          return {};
        },
        notifications: (async function* () {
          yield {
            method: "item/completed",
            params: {
              threadId: "thread-parent",
              item: {
                id: "item-spawn",
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                receiverThreadIds: ["thread-child"],
                agentsStates: {
                  "thread-child": {
                    status: "running",
                    message: null,
                  },
                },
                status: "completed",
              },
            },
          };
          yield {
            method: "item/completed",
            params: {
              threadId: "thread-child",
              item: {
                id: "item-child-message",
                type: "agentMessage",
                text: "SUBAGENT_HEADER_LIVE_PROOF: hello from sub-agent.",
              },
            },
          };
          yield {
            method: "turn/completed",
            params: {
              threadId: "thread-parent",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          };
        })(),
        close: async () => {},
      }),
    });

    await started.done;

    assert.deepEqual(responses, [{
      text: "SUBAGENT_HEADER_LIVE_PROOF: hello from sub-agent.",
      metadata: {
        source: "subagent",
        threadId: "thread-child",
        parentThreadId: "thread-parent",
        agentNickname: "Planck",
        agentRole: "default",
      },
    }]);
  });

  it("passes on-request approval policy through unchanged", async () => {
    const connectionMock = createOpenConnectionMock();

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo/project",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      },
    }, {
      openConnection: connectionMock.openConnection,
    });

    await started.done;

    assert.deepEqual(connectionMock.sendRequests.slice(0, 2), [
      {
        method: "thread/start",
        params: {
          cwd: "/repo/project",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          serviceName: "madabot",
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: "Continue" }],
          cwd: "/repo/project",
          approvalPolicy: mapCodexAppServerApprovalPolicy("on-request"),
          approvalsReviewer: "auto_review",
          sandboxPolicy: buildCodexAppServerSandboxPolicy({
            workdir: "/repo/project",
            sandboxMode: "workspace-write",
          }),
        },
      },
    ]);
  });

  it("passes on-failure approval policy through unchanged", () => {
    assert.equal(mapCodexAppServerApprovalPolicy("on-failure"), "on-failure");
  });

  it("recovers a completed turn from thread history after a mid-run connection close", async () => {
    /** @type {Array<{ method: string, params: Record<string, unknown> }>} */
    const sendRequests = [];
    /** @type {string[]} */
    const progress = [];
    let openAttempts = 0;

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {
        onLlmResponse: async (text) => {
          progress.push(text);
        },
      },
    }, {
      openConnection: async () => {
        openAttempts += 1;
        return {
          async sendRequest(method, params = {}) {
            sendRequests.push({ method, params });
            if (method === "thread/start") {
              return { thread: { id: "thread-1" } };
            }
            if (method === "turn/start") {
              return { turn: { id: "turn-1" } };
            }
            if (method === "thread/read") {
              return {
                thread: {
                  id: "thread-1",
                  turns: [{
                    id: "turn-1",
                    status: "completed",
                    items: [
                      { type: "agentMessage", text: "Recovered final answer", phase: "final_answer" },
                    ],
                  }],
                },
              };
            }
            return {};
          },
          notifications: (async function* () {
            yield {
              method: "turn/started",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "inProgress",
                  error: null,
                },
              },
            };
            throw new Error("Connection Closed");
          })(),
          close: async () => {},
        };
      },
    });

    const completed = await started.done;

    assert.equal(openAttempts, 2);
    assert.deepEqual(sendRequests.map((request) => request.method), ["thread/start", "turn/start", "thread/read"]);
    assert.deepEqual(progress, ["Recovered final answer"]);
    assert.deepEqual(completed.result.response, [{ type: "markdown", text: "Recovered final answer" }]);
    assert.equal(completed.sessionId, "thread-1");
  });

  it("recovers a completed turn from thread history when notifications end before turn completion", async () => {
    /** @type {Array<{ method: string, params: Record<string, unknown> }>} */
    const sendRequests = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    }, {
      openConnection: async () => ({
        async sendRequest(method, params = {}) {
          sendRequests.push({ method, params });
          if (method === "thread/start") {
            return { thread: { id: "thread-1" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          if (method === "thread/read") {
            return {
              thread: {
                id: "thread-1",
                turns: [{
                  id: "turn-1",
                  status: "completed",
                  items: [
                    { type: "agentMessage", text: "Recovered after silent close", phase: "final_answer" },
                  ],
                }],
              },
            };
          }
          return {};
        },
        notifications: (async function* () {})(),
        close: async () => {},
      }),
    });

    const completed = await started.done;

    assert.deepEqual(sendRequests.map((request) => request.method), ["thread/start", "turn/start", "thread/read"]);
    assert.deepEqual(completed.result.response, [{ type: "markdown", text: "Recovered after silent close" }]);
    assert.equal(completed.sessionId, "thread-1");
  });

  it("reports a recoverable interruption when reconnect shows the turn is still running", async () => {
    /** @type {string[]} */
    const toolErrors = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      hooks: {
        onToolError: async (message) => {
          toolErrors.push(message);
        },
      },
    }, {
      openConnection: async () => ({
        async sendRequest(method) {
          if (method === "thread/start") {
            return { thread: { id: "thread-1" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          if (method === "thread/read") {
            return {
              thread: {
                id: "thread-1",
                turns: [{
                  id: "turn-1",
                  status: "inProgress",
                  items: [],
                }],
              },
            };
          }
          return {};
        },
        notifications: (async function* () {})(),
        close: async () => {},
      }),
    });

    await assert.rejects(
      started.done,
      /Codex disconnected while the turn was still in progress/,
    );
    assert.deepEqual(toolErrors, ["Codex disconnected while the turn was still in progress. Send a follow-up after a moment to resume the saved thread."]);
  });

  it("waits for turn startup before steering early follow-up input", async () => {
    const notificationController = createNotificationController();
    /** @type {Array<{ method: string, params: Record<string, unknown> }>} */
    const sendRequests = [];
    /** @type {Array<(value: unknown) => void>} */
    const pendingSteerResolutions = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    }, {
      openConnection: async () => ({
        async sendRequest(method, params = {}) {
          sendRequests.push({ method, params });
          if (method === "thread/start") {
            return { thread: { id: "thread-1" } };
          }
          if (method === "turn/start") {
            return { turn: { id: "turn-1" } };
          }
          if (method === "turn/steer") {
            return new Promise((resolve) => {
              pendingSteerResolutions.push(resolve);
            });
          }
          return {};
        },
        notifications: notificationController.notifications,
        close: async () => {},
      }),
    });

    const steerPromise = started.steer("Use the newer instruction");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(sendRequests.map((request) => request.method), ["thread/start", "turn/start"]);

    notificationController.push({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "inProgress",
          error: null,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(sendRequests.map((request) => request.method), ["thread/start", "turn/start", "turn/steer"]);
    assert.deepEqual(sendRequests.at(-1), {
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Use the newer instruction" }],
        expectedTurnId: "turn-1",
      },
    });

    pendingSteerResolutions.shift()?.({ turnId: "turn-1" });
    assert.equal(await steerPromise, true);

    notificationController.push({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
        },
      },
    });
    notificationController.end();
    await started.done;
  });
});

describe("handleCodexAppServerRequest", () => {
  it("returns a structured accept decision for command approvals", async () => {
    /** @type {Array<{ question: string, options: string[], details: string[] | undefined }>} */
    const prompts = [];
    const hooks = {
      onAskUser: async (question, options, _defaultOption, details) => {
        prompts.push({ question, options, details });
        return "✅ Allow";
      },
    };

    const result = await handleCodexAppServerRequest({
      method: "item/commandExecution/requestApproval",
      params: {
        command: "/bin/zsh -lc 'git commit -m test'",
        availableDecisions: ["accept", "cancel"],
      },
    }, hooks);

    assert.deepEqual(result, { decision: "accept" });
    assert.deepEqual(prompts, [{
      question: "Allow *command execution*?",
      options: ["✅ Allow", "❌ Deny"],
      details: ["/bin/zsh -lc 'git commit -m test'"],
    }]);
  });

  it("returns a structured cancel decision when the user denies command approval", async () => {
    const result = await handleCodexAppServerRequest({
      method: "item/commandExecution/requestApproval",
      params: {
        command: "/bin/zsh -lc 'git commit -m test'",
        availableDecisions: ["accept", "cancel"],
      },
    }, {
      onAskUser: async () => "❌ Deny",
    });

    assert.deepEqual(result, { decision: "cancel" });
  });

  it("auto-allows low-risk tracked file changes without prompting", async () => {
    const tracker = {
      get: (itemId) => itemId === "file-1"
        ? {
          itemId,
          decision: null,
          changes: [{ path: "/repo/src/app.js", summary: "/repo/src/app.js (update)", kind: "update" }],
        }
        : null,
      markDecision: () => {},
    };

    const result = await handleCodexAppServerRequest({
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "file-1",
      },
    }, {
      onAskUser: async () => {
        assert.fail("onAskUser should not be called for low-risk tracked file changes");
      },
      onFileChange: async () => {
        assert.fail("onFileChange should not be called when auto-approving");
      },
    }, {
      fileChangeTracker: tracker,
      runConfig: { workdir: "/repo" },
    });

    assert.deepEqual(result, { decision: "accept" });
  });

  it("prompts for risky tracked file changes without emitting empty proposed lifecycle events", async () => {
    /** @type {Array<{ question: string, options: string[], details: string[] | undefined }>} */
    const prompts = [];
    /** @type {Array<Record<string, unknown>>} */
    const deniedEvents = [];
    const decisions = [];
    const tracker = {
      get: (itemId) => itemId === "file-2"
        ? {
          itemId,
          decision: null,
          changes: [{ path: "/repo/harnesses/codex-app-server-events.js", summary: "sensitive change", kind: "update" }],
        }
        : null,
      markDecision: (itemId, decision) => {
        decisions.push({ itemId, decision });
      },
    };

    const result = await handleCodexAppServerRequest({
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "file-2",
      },
    }, {
      onAskUser: async (question, options, _defaultOption, details) => {
        prompts.push({ question, options, details });
        return "❌ Deny";
      },
      onFileChange: async (event) => {
        deniedEvents.push(event);
      },
    }, {
      fileChangeTracker: tracker,
      runConfig: { workdir: "/repo" },
    });

    assert.deepEqual(result, { decision: "cancel" });
    assert.deepEqual(prompts, [{
      question: "Allow *file changes*?",
      options: ["✅ Allow", "❌ Deny"],
      details: ["/repo/harnesses/codex-app-server-events.js"],
    }]);
    assert.deepEqual(decisions, [{ itemId: "file-2", decision: "cancel" }]);
    assert.deepEqual(deniedEvents, [{
      path: "/repo/harnesses/codex-app-server-events.js",
      summary: "sensitive change",
      kind: "update",
      itemId: "file-2",
      stage: "denied",
    }]);
  });

  it("emits proposed lifecycle events only when a prompted file change already includes a diff", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const fileChangeEvents = [];
    const tracker = {
      get: (itemId) => itemId === "file-3"
        ? {
          itemId,
          decision: null,
          changes: [{
            path: "/repo/harnesses/codex-app-server-events.js",
            summary: "/repo/harnesses/codex-app-server-events.js (update)",
            kind: "update",
            diff: [
              "--- a/harnesses/codex-app-server-events.js",
              "+++ b/harnesses/codex-app-server-events.js",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
          }],
        }
        : null,
      markDecision: () => {},
    };

    const result = await handleCodexAppServerRequest({
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "file-3",
      },
    }, {
      onAskUser: async () => "❌ Deny",
      onFileChange: async (event) => {
        fileChangeEvents.push(event);
      },
    }, {
      fileChangeTracker: tracker,
      runConfig: { workdir: "/repo" },
    });

    assert.deepEqual(result, { decision: "cancel" });
    assert.deepEqual(fileChangeEvents, [
      {
        path: "/repo/harnesses/codex-app-server-events.js",
        summary: "/repo/harnesses/codex-app-server-events.js (update)",
        kind: "update",
        diff: [
          "--- a/harnesses/codex-app-server-events.js",
          "+++ b/harnesses/codex-app-server-events.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        itemId: "file-3",
        stage: "proposed",
      },
      {
        path: "/repo/harnesses/codex-app-server-events.js",
        summary: "/repo/harnesses/codex-app-server-events.js (update)",
        kind: "update",
        diff: [
          "--- a/harnesses/codex-app-server-events.js",
          "+++ b/harnesses/codex-app-server-events.js",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        itemId: "file-3",
        stage: "denied",
      },
    ]);
  });
});

describe("startCodexAppServerRun file-change lifecycle", () => {
  it("emits only applied file changes for auto-accepted app-server fileChange items", async () => {
    const connectionMock = createOpenConnectionMock();
    /** @type {Array<Record<string, unknown>>} */
    const fileChanges = [];

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/repo",
      },
      hooks: {
        onFileChange: async (event) => {
          fileChanges.push(event);
        },
      },
    }, {
      openConnection: (options = {}) => connectionMock.openConnection({
        ...options,
        notifications: [
          {
            method: "item/started",
            params: {
              threadId: "thread-1",
              item: {
                id: "file-1",
                type: "fileChange",
                changes: [{ path: "/repo/src/app.js", kind: { type: "update", move_path: null } }],
                status: "inProgress",
              },
            },
          },
          {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              item: {
                id: "file-1",
                type: "fileChange",
                changes: [{ path: "/repo/src/app.js", kind: { type: "update", move_path: null } }],
                status: "completed",
              },
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          },
        ],
      }),
    });

    await started.done;

    assert.deepEqual(fileChanges, [{
      path: "/repo/src/app.js",
      summary: "/repo/src/app.js (update)",
      kind: "update",
      itemId: "file-1",
      stage: "applied",
    }]);
  });

  it("keeps hunk-only app-server update diffs as update file changes", async () => {
    const connectionMock = createOpenConnectionMock();
    /** @type {Array<Record<string, unknown>>} */
    const fileChanges = [];
    const filePath = "/outside/repo/tests/codex-run-state.test.js";
    const diff = [
      "@@ -1,1 +1,1 @@",
      "-old test name",
      "+new test name",
    ].join("\n");

    const started = await startCodexAppServerRun({
      chatId: "chat-1",
      prompt: "Continue",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
      runConfig: {
        workdir: "/chat/workspace",
      },
      hooks: {
        onFileChange: async (event) => {
          fileChanges.push(event);
        },
      },
    }, {
      openConnection: (options = {}) => connectionMock.openConnection({
        ...options,
        notifications: [
          {
            method: "item/started",
            params: {
              threadId: "thread-1",
              item: {
                id: "file-1",
                type: "fileChange",
                changes: [{ path: filePath, kind: { type: "update", move_path: null }, diff }],
                status: "inProgress",
              },
            },
          },
          {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              item: {
                id: "file-1",
                type: "fileChange",
                changes: [{ path: filePath, kind: { type: "update", move_path: null }, diff }],
                status: "completed",
              },
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: "completed",
                error: null,
              },
            },
          },
        ],
      }),
    });

    await started.done;

    assert.deepEqual(fileChanges, [{
      path: filePath,
      summary: `${filePath} (update)`,
      kind: "update",
      diff,
      oldText: "old test name\n",
      newText: "new test name\n",
      itemId: "file-1",
      stage: "applied",
    }]);
  });
});
