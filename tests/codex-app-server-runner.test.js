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

describe("startCodexAppServerRun", () => {
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
          sandboxPolicy: buildCodexAppServerSandboxPolicy({
            workdir: "/repo/project",
            sandboxMode: "workspace-write",
          }),
        },
      },
    ]);
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
});
