import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createCodexActionMcpBridge,
  handleCodexActionMcpRequest,
} from "../harnesses/codex-action-mcp-bridge.js";

/**
 * @returns {ExecuteActionContext}
 */
function createMockContext() {
  return /** @type {ExecuteActionContext} */ ({
    chatId: "chat-1",
    senderIds: ["master-user"],
    senderJids: ["master-user@s.whatsapp.net"],
    senderName: "Test User",
    content: [],
    getIsAdmin: async () => true,
    send: async () => undefined,
    reply: async () => undefined,
    reactToMessage: async () => {},
    select: async () => "",
    confirm: async () => true,
  });
}

/** @type {Array<() => Promise<void>>} */
const cleanups = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("handleCodexActionMcpRequest", () => {
  it("responds to initialize and exposes only the curated tool subset", async () => {
    const tools = [{
      name: "send_path",
      description: "Send a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    }];

    const initialized = await handleCodexActionMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }, {
      listTools: async () => tools,
      callTool: async () => {
        throw new Error("callTool should not be invoked during initialize");
      },
    });

    assert.deepEqual(initialized, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "madabot-codex-actions",
          version: "1.0.0",
        },
      },
    });

    const listed = await handleCodexActionMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, {
      listTools: async () => tools,
      callTool: async () => {
        throw new Error("callTool should not be invoked during tools/list");
      },
    });

    assert.deepEqual(listed, {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [{
          name: "send_path",
          description: "Send a file.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        }],
      },
    });
  });
});

describe("createCodexActionMcpBridge", () => {
  it("executes send_path through the action runtime and emits attachment blocks immediately", async () => {
    /** @type {Array<{ blocks: ToolContentBlock[], toolName: string }>} */
    const toolResults = [];
    /** @type {Array<{ name: string, params: Record<string, unknown>, options: Record<string, unknown> }>} */
    const executions = [];

    const bridge = await createCodexActionMcpBridge({
      toolRuntime: /** @type {ToolRuntime} */ ({
        listTools: () => [{
          name: "send_path",
          description: "Send a local file or directory path back to the user.",
          instructions: "Use send_path when you want to send a generated file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
          permissions: { autoExecute: true, autoContinue: true, requireMaster: true },
        }],
        getTool: async (name) => name === "send_path"
          ? {
            name: "send_path",
            description: "Send a local file or directory path back to the user.",
            instructions: "Use send_path when you want to send a generated file.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
            permissions: { autoExecute: true, autoContinue: true, requireMaster: true },
          }
          : null,
        executeTool: async (name, _context, params, options = {}) => {
          executions.push({ name, params, options: /** @type {Record<string, unknown>} */ (options) });
          return {
            result: [{
              type: "file",
              file_name: "report.txt",
              mime_type: "text/plain",
              encoding: "base64",
              data: Buffer.from("report body").toString("base64"),
            }],
            permissions: { autoExecute: true, autoContinue: true, requireMaster: true },
          };
        },
      }),
      session: {
        chatId: "chat-1",
        senderIds: ["master-user"],
        context: createMockContext(),
        addMessage: async () => undefined,
        updateToolMessage: async () => undefined,
        harnessSession: null,
        saveHarnessSession: async () => undefined,
      },
      hooks: {
        onToolResult: async (blocks, toolName) => {
          toolResults.push({ blocks, toolName });
        },
      },
      runConfig: {
        workdir: "/repo/project",
        sandboxMode: "workspace-write",
      },
    });
    cleanups.push(() => bridge.close());

    const result = await bridge.callTool("send_path", { path: "artifacts/report.txt" }, "call-1");

    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{
      type: "text",
      text: "Sent report.txt to the chat.",
    }]);
    assert.deepEqual(executions, [{
      name: "send_path",
      params: { path: "artifacts/report.txt" },
      options: {
        toolCallId: "call-1",
        workdir: "/repo/project",
        sandboxMode: "workspace-write",
      },
    }]);
    assert.deepEqual(toolResults, [{
      toolName: "send_path",
      blocks: [{
        type: "file",
        file_name: "report.txt",
        mime_type: "text/plain",
        encoding: "base64",
        data: Buffer.from("report body").toString("base64"),
      }],
    }]);
    assert.ok(bridge.codexArgs.some((value) => value.includes("mcp_servers.madabot_send_path.command=")));
    assert.ok(bridge.codexArgs.some((value) => value.includes("mcp_servers.madabot_send_path.args=")));
    assert.ok(bridge.codexArgs.some((value) => value.includes("mcp_servers.madabot_send_path.env.MADABOT_CODEX_ACTION_MCP_SOCKET=")));
  });
});
