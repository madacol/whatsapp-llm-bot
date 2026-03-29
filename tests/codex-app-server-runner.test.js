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
          yield {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
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
  };
}

describe("startCodexAppServerRun", () => {
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
          serviceName: "whatsapp-llm-bot",
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
});
