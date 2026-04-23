import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_SERVER_INFO = {
  name: "madabot-codex-actions",
  version: "1.0.0",
};
const MCP_SERVER_CONFIG_NAME = "madabot_send_path";
const MCP_SOCKET_ENV_VAR = "MADABOT_CODEX_ACTION_MCP_SOCKET";
const MCP_TOKEN_ENV_VAR = "MADABOT_CODEX_ACTION_MCP_TOKEN";
const EXPOSED_ACTION_NAMES = new Set(["send_path"]);

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, unknown>,
 * }} CodexActionMcpTool
 */

/**
 * @typedef {{
 *   listTools: () => Promise<CodexActionMcpTool[]>,
 *   callTool: (toolName: string, params: Record<string, unknown>, callId: string | null) => Promise<{
 *     content: Array<{ type: "text", text: string }>,
 *     isError?: boolean,
 *   }>,
 * }} CodexActionMcpService
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is ToolContentBlock[]}
 */
function isToolContentBlockArray(value) {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.type === "string");
}

/**
 * @param {ToolDescriptor} tool
 * @returns {CodexActionMcpTool}
 */
function toCodexActionMcpTool(tool) {
  const descriptionParts = [tool.description];
  if (typeof tool.instructions === "string" && tool.instructions.trim().length > 0) {
    descriptionParts.push(tool.instructions.trim());
  }
  return {
    name: tool.name,
    description: descriptionParts.filter((part) => typeof part === "string" && part.trim().length > 0).join("\n\n"),
    parameters: tool.parameters,
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
function toTomlString(value) {
  return JSON.stringify(value);
}

/**
 * @param {string[]} values
 * @returns {string}
 */
function toTomlStringArray(values) {
  return `[${values.map((value) => toTomlString(value)).join(", ")}]`;
}

/**
 * @param {ToolContentBlock[]} blocks
 * @returns {ToolContentBlock[]}
 */
function getNonTextBlocks(blocks) {
  return blocks.filter((block) => block.type !== "text" && block.type !== "markdown");
}

/**
 * @param {ToolContentBlock[]} blocks
 * @returns {string | null}
 */
function getAttachmentLabel(blocks) {
  for (const block of blocks) {
    if ("file_name" in block && typeof block.file_name === "string" && block.file_name.trim().length > 0) {
      return block.file_name.trim();
    }
    if ("path" in block && typeof block.path === "string" && block.path.trim().length > 0) {
      return path.basename(block.path.trim());
    }
  }
  return null;
}

/**
 * @param {string} toolName
 * @param {ActionResultValue} result
 * @returns {{ content: Array<{ type: "text", text: string }>, isError?: boolean }}
 */
function normalizeToolCallResult(toolName, result) {
  if (isToolContentBlockArray(result)) {
    const attachmentLabel = getAttachmentLabel(result);
    const defaultText = attachmentLabel
      ? `Sent ${attachmentLabel} to the chat.`
      : `Completed ${toolName}.`;
    return {
      content: [{ type: "text", text: defaultText }],
      isError: false,
    };
  }

  if (typeof result === "string") {
    return {
      content: [{ type: "text", text: result }],
      isError: false,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: false,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function readArgumentsRecord(value) {
  return isRecord(value) ? value : {};
}

/**
 * @param {unknown} id
 * @returns {string | number | null}
 */
function normalizeJsonRpcId(id) {
  if (typeof id === "string" || typeof id === "number") {
    return id;
  }
  return null;
}

/**
 * @param {unknown} request
 * @param {CodexActionMcpService} service
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function handleCodexActionMcpRequest(request, service) {
  if (!isRecord(request)) {
    return null;
  }

  const method = typeof request.method === "string" ? request.method : null;
  const id = normalizeJsonRpcId(request.id);
  const hasId = request.id !== undefined && id !== null;

  if (!method) {
    return hasId
      ? {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32600,
          message: "Invalid Request",
        },
      }
      : null;
  }

  if (!hasId && (method === "notifications/initialized" || method === "initialized")) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: MCP_SERVER_INFO,
      },
    };
  }

  if (method === "ping") {
    return {
      jsonrpc: "2.0",
      id,
      result: {},
    };
  }

  if (method === "tools/list") {
    const tools = await service.listTools();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const params = isRecord(request.params) ? request.params : {};
    const toolName = typeof params.name === "string" ? params.name : null;
    if (!toolName) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Invalid tool call parameters.",
        },
      };
    }

    const result = await service.callTool(toolName, readArgumentsRecord(params.arguments), id == null ? null : String(id));
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  return hasId
    ? {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    }
    : null;
}

/**
 * @param {{
 *   toolRuntime: ToolRuntime,
 *   session: Session,
 *   hooks: Pick<AgentIOHooks, "onToolResult">,
 *   runConfig?: HarnessRunConfig,
 * }} input
 * @returns {Promise<{
 *   env: Record<string, string>,
 *   codexArgs: string[],
 *   listTools: () => Promise<CodexActionMcpTool[]>,
 *   callTool: CodexActionMcpService["callTool"],
 *   close: () => Promise<void>,
 * }>}
 */
export async function createCodexActionMcpBridge(input) {
  const listedTools = typeof input.toolRuntime.listTools === "function"
    ? input.toolRuntime.listTools()
    : [];
  const exposedTools = listedTools
    .filter((tool) => EXPOSED_ACTION_NAMES.has(tool.name))
    .map(toCodexActionMcpTool);

  if (exposedTools.length === 0) {
    return {
      env: {},
      codexArgs: [],
      listTools: async () => [],
      callTool: async (_toolName, _params, _callId) => ({
        content: [{ type: "text", text: "No Codex action tools are available." }],
        isError: true,
      }),
      close: async () => {},
    };
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "madabot-codex-action-mcp-"));
  const socketPath = path.join(runtimeDir, "bridge.sock");
  const token = randomUUID();

  /**
   * @param {string} toolName
   * @param {Record<string, unknown>} params
   * @param {string | null} callId
   * @returns {Promise<{ content: Array<{ type: "text", text: string }>, isError?: boolean }>}
   */
  async function callTool(toolName, params, callId) {
    const tool = await input.toolRuntime.getTool(toolName);
    if (!tool || !EXPOSED_ACTION_NAMES.has(tool.name)) {
      return {
        content: [{ type: "text", text: `Unknown Codex action tool: ${toolName}` }],
        isError: true,
      };
    }

    try {
      const executed = await input.toolRuntime.executeTool(tool.name, input.session.context, params, {
        ...(callId ? { toolCallId: callId } : {}),
        workdir: input.runConfig?.workdir ?? null,
        sandboxMode: input.runConfig?.sandboxMode ?? null,
      });
      if (isToolContentBlockArray(executed.result)) {
        const nonTextBlocks = getNonTextBlocks(executed.result);
        if (nonTextBlocks.length > 0) {
          await input.hooks.onToolResult?.(nonTextBlocks, tool.name, executed.permissions);
        }
      }
      return normalizeToolCallResult(tool.name, executed.result);
    } catch (error) {
      return {
        content: [{ type: "text", text: getErrorMessage(error) }],
        isError: true,
      };
    }
  }

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (request.method === "GET" && request.url === "/tools") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tools: exposedTools }));
      return;
    }

    if (request.method === "POST" && request.url === "/tools/call") {
      /** @type {Buffer[]} */
      const chunks = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", async () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!isRecord(parsed) || typeof parsed.name !== "string") {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Invalid request body" }));
            return;
          }

          const result = await callTool(
            parsed.name,
            readArgumentsRecord(parsed.arguments),
            typeof parsed.callId === "string" && parsed.callId.trim().length > 0 ? parsed.callId : null,
          );
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: getErrorMessage(error),
          }));
        }
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });

  const scriptPath = fileURLToPath(new URL("../scripts/run-codex-action-mcp.js", import.meta.url));
  const codexArgs = [
    "-c",
    `mcp_servers.${MCP_SERVER_CONFIG_NAME}.command=${toTomlString(process.execPath)}`,
    "-c",
    `mcp_servers.${MCP_SERVER_CONFIG_NAME}.args=${toTomlStringArray([scriptPath])}`,
    "-c",
    `mcp_servers.${MCP_SERVER_CONFIG_NAME}.env.${MCP_SOCKET_ENV_VAR}=${toTomlString(socketPath)}`,
    "-c",
    `mcp_servers.${MCP_SERVER_CONFIG_NAME}.env.${MCP_TOKEN_ENV_VAR}=${toTomlString(token)}`,
  ];

  return {
    env: {
      [MCP_SOCKET_ENV_VAR]: socketPath,
      [MCP_TOKEN_ENV_VAR]: token,
    },
    codexArgs,
    listTools: async () => exposedTools,
    callTool,
    close: async () => {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
      });
      await rm(runtimeDir, { recursive: true, force: true });
    },
  };
}
