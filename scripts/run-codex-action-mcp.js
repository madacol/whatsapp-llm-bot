#!/usr/bin/env node

import { request as httpRequest } from "node:http";
import readline from "node:readline";

import { handleCodexActionMcpRequest } from "../harnesses/codex-action-mcp-bridge.js";

const socketPath = process.env.MADABOT_CODEX_ACTION_MCP_SOCKET ?? "";
const token = process.env.MADABOT_CODEX_ACTION_MCP_TOKEN ?? "";

if (!socketPath || !token) {
  process.stderr.write("Missing MADABOT_CODEX_ACTION_MCP_SOCKET or MADABOT_CODEX_ACTION_MCP_TOKEN.\n");
  process.exit(1);
}

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, unknown>,
 * }} BridgeTool
 */

/**
 * @typedef {{
 *   tools: BridgeTool[],
 * }} BridgeToolsResponse
 */

/**
 * @typedef {{
 *   content: Array<{ type: "text", text: string }>,
 *   isError?: boolean,
 * }} BridgeToolCallResponse
 */

/**
 * @param {string} method
 * @param {string} requestPath
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
function sendBridgeRequest(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      method,
      socketPath,
      path: requestPath,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
    }, (response) => {
      /** @type {Buffer[]} */
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text) {
            resolve(undefined);
            return;
          }
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

/**
 * @param {unknown} value
 * @returns {value is BridgeToolsResponse}
 */
function isBridgeToolsResponse(value) {
  return !!value
    && typeof value === "object"
    && "tools" in value
    && Array.isArray(value.tools);
}

/**
 * @param {unknown} value
 * @returns {value is BridgeToolCallResponse}
 */
function isBridgeToolCallResponse(value) {
  return !!value
    && typeof value === "object"
    && "content" in value
    && Array.isArray(value.content);
}

/** @type {import("../harnesses/codex-action-mcp-bridge.js").CodexActionMcpService} */
const service = {
  listTools: async () => {
    const response = await sendBridgeRequest("GET", "/tools");
    if (!isBridgeToolsResponse(response)) {
      return [];
    }
    return response.tools;
  },
  callTool: async (toolName, params, callId) => {
    const response = await sendBridgeRequest("POST", "/tools/call", {
      name: toolName,
      arguments: params,
      callId,
    });
    if (!isBridgeToolCallResponse(response)) {
      return {
        content: [{ type: "text", text: "Invalid response from Madabot Codex action bridge." }],
        isError: true,
      };
    }
    return response;
  },
};

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of lines) {
  if (!line.trim()) {
    continue;
  }

  try {
    const message = JSON.parse(line);
    const response = await handleCodexActionMcpRequest(message, service);
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message,
      },
    })}\n`);
  }
}
