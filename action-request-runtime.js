import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createImageBlockFromPath, mediaPathToMimeType } from "./media-store.js";

export const ACTION_REQUESTS_ENV_VAR = "WHATSAPP_ACTION_REQUESTS_DIR";
const ACTION_REQUEST_KIND = "whatsapp-action-request";
const ACTION_REQUESTS_DIR = path.join(".agents", ".runtime", "action-requests");

/**
 * @typedef {{
 *   kind: "whatsapp-action-request",
 *   action: string,
 *   arguments: Record<string, unknown>,
 *   cwd?: string,
 * }} QueuedActionRequest
 */

/**
 * @param {string} workdir
 * @returns {{
 *   requestsDir: string,
 *   env: Record<string, string>,
 *   cleanup: () => Promise<void>,
 * }}
 */
export function createActionRequestRunState(workdir) {
  const requestsDir = path.join(workdir, ACTION_REQUESTS_DIR, randomUUID());

  return {
    requestsDir,
    env: {
      [ACTION_REQUESTS_ENV_VAR]: requestsDir,
    },
    cleanup: async () => {
      await rm(requestsDir, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} requestsDir
 * @param {{
 *   toolRuntime: ToolRuntime,
 *   session: Session,
 *   hooks: Pick<AgentIOHooks, "onToolCall" | "onToolResult" | "onToolError">,
 *   messages: Message[],
 *   runConfig?: HarnessRunConfig,
 * }} input
 * @returns {Promise<ToolContentBlock[]>}
 */
export async function executeQueuedActionRequests(requestsDir, input) {
  const requests = await readQueuedActionRequests(requestsDir);
  /** @type {ToolContentBlock[]} */
  let latestBlocks = [];

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const tool = await input.toolRuntime.getTool(request.action);
    if (!tool) {
      const errorText = `Unknown queued action: ${request.action}`;
      latestBlocks = [{ type: "text", text: errorText }];
      await input.hooks.onToolError?.(errorText);
      continue;
    }

    const toolCall = {
      id: `queued-action:${tool.name}:${index + 1}`,
      name: tool.name,
      arguments: JSON.stringify(request.arguments),
    };
    const handle = await input.hooks.onToolCall?.(toolCall, tool.formatToolCall);
    const params = normalizeQueuedActionArguments(tool.name, request.arguments);
    const actionResult = await input.toolRuntime.executeTool(
      tool.name,
      input.session.context,
      params,
      {
        workdir: request.cwd ?? input.runConfig?.workdir ?? null,
        sandboxMode: input.runConfig?.sandboxMode ?? null,
      },
    );

    const blocks = normalizeActionResult(actionResult.result);
    latestBlocks = blocks;

    /** @type {ToolMessage} */
    const toolMessage = {
      role: "tool",
      tool_id: toolCall.id,
      content: blocks,
    };
    input.messages.push(toolMessage);
    await input.session.addMessage(
      input.session.chatId,
      toolMessage,
      input.session.senderIds,
      handle?.keyId,
    );
    await input.hooks.onToolResult?.(blocks, tool.name, actionResult.permissions);
  }

  return latestBlocks;
}

/**
 * @param {string} requestsDir
 * @param {QueuedActionRequest} request
 * @returns {Promise<string>}
 */
export async function writeQueuedActionRequest(requestsDir, request) {
  await mkdir(requestsDir, { recursive: true });
  const fileName = `${Date.now()}-${randomUUID()}.json`;
  const requestPath = path.join(requestsDir, fileName);
  await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");
  return requestPath;
}

/**
 * @param {string} requestsDir
 * @returns {Promise<QueuedActionRequest[]>}
 */
async function readQueuedActionRequests(requestsDir) {
  let fileNames;
  try {
    fileNames = await readdir(requestsDir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const sortedNames = [...fileNames].sort((left, right) => left.localeCompare(right));
  /** @type {QueuedActionRequest[]} */
  const requests = [];

  for (const fileName of sortedNames) {
    const requestPath = path.join(requestsDir, fileName);
    const parsed = parseQueuedActionRequest(await readFile(requestPath, "utf8"));
    if (parsed) {
      requests.push(parsed);
    }
  }

  return requests;
}

/**
 * @param {string} text
 * @returns {QueuedActionRequest | null}
 */
function parseQueuedActionRequest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.kind !== ACTION_REQUEST_KIND || typeof parsed.action !== "string" || !parsed.action.trim()) {
    return null;
  }
  if (!isRecord(parsed.arguments)) {
    return null;
  }
  return {
    kind: ACTION_REQUEST_KIND,
    action: parsed.action.trim(),
    arguments: parsed.arguments,
    ...(typeof parsed.cwd === "string" && parsed.cwd.trim() ? { cwd: parsed.cwd } : {}),
  };
}

/**
 * @param {string} actionName
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
function normalizeQueuedActionArguments(actionName, args) {
  if (actionName === "generate_image") {
    const normalized = { ...args };
    const imagePaths = readStringArrayProperty(args, "image_paths");
    if (imagePaths.length > 0) {
      normalized.images = imagePaths.map((imagePath) => createImageBlockFromPath(imagePath));
    }
    delete normalized.image_paths;
    return normalized;
  }

  if (actionName === "generate_video") {
    const normalized = { ...args };
    const imagePath = readOptionalStringProperty(args, "image_path");
    if (imagePath) {
      normalized.image = {
        type: "image",
        path: imagePath,
        mime_type: mediaPathToMimeType(imagePath, "image/jpeg"),
      };
    }
    delete normalized.image_path;
    return normalized;
  }

  return args;
}

/**
 * @param {ActionResultValue} result
 * @returns {ToolContentBlock[]}
 */
function normalizeActionResult(result) {
  if (isToolContentBlockArray(result)) {
    return result;
  }
  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }
  return [{ type: "text", text: JSON.stringify(result) }];
}

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
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {string[]}
 */
function readStringArrayProperty(record, key) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {string | null}
 */
function readOptionalStringProperty(record, key) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException}
 */
function isMissingFileError(error) {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code === "ENOENT";
}
