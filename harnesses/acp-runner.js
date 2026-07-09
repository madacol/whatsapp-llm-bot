import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hasInlineMediaData, hasMediaPath, isValidMediaPath, resolveMediaPath } from "../attachment-paths.js";
import { openAcpConnection, resolveAcpCommandPath } from "./acp-client.js";
import { hasAcpSessionCapability, hasMadabotAcpSessionCapability, supportsAcpLoadSession } from "./acp-capabilities.js";
import { createAcpRawPayload, createAcpRuntimeModel, normalizeAcpUsage } from "./acp-events.js";
import {
  collectAcpTargetedFileChanges,
  collectAcpSnapshotFileChanges,
  emitAcpSnapshotFileChangeEvents,
  isAcpFileChangeIgnored,
  reconcileAcpFileChangeWithBaseline,
  resolveAcpFileChangePath,
  snapshotAcpPaths,
  snapshotAcpWorkdir,
  updateAcpFileChangeBaseline,
} from "./acp-file-changes.js";
import { extractApplyPatchTargetPaths } from "./apply-patch-parser.js";
import { createAcpExtensionRouter } from "./acp-extension-router.js";
import { createHarnessRuntimeEventDispatcher } from "./harness-runtime-event-dispatcher.js";
import { getProtectedPathPatterns, matchProtectedPath, requestProtectedPathApproval, restoreProtectedPath } from "./protected-paths.js";
import { createLogger } from "../logger.js";
import { createAcpClientRequestHandler } from "./acp-client-request-channel.js";

const log = createLogger("harness:acp-runner");
const ACP_HANDSHAKE_TIMEOUT_MS = 30_000;
const ACP_SESSION_REQUEST_TIMEOUT_MS = 30_000;
const ACP_PROMPT_TIMEOUT_MS = 20 * 60_000;

/**
 * @typedef {{
 *   command: string,
 *   args?: string[],
 *   prompt: string,
 *   attachments?: IncomingContentBlock[],
 *   messages?: Message[],
 *   sessionId?: string | null,
 *   runConfig?: HarnessRunConfig,
 *   hooks?: AgentIOHooks,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   emitEvent?: (event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => void,
 *   dispatchRuntimeEventsToHooks?: boolean,
 *   requestDecision?: (request: { id: string, title: string, labels: string[], descriptions: string[] }) => Promise<string | null>,
 *   userInputDecision?: (request: import("./harness-runtime-events.js").HarnessRuntimeUserInputRequest) => Promise<unknown>,
 *   onActiveRun?: (run: { connection: Awaited<ReturnType<typeof openAcpConnection>>, sessionId: string | null, capabilities: Record<string, unknown> }) => void | (() => void),
 * }} AcpRunInput
 */

/**
 * @typedef {{
 *   command: string,
 *   args?: string[],
 *   sessionId: string,
 *   runConfig?: HarnessRunConfig,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} AcpForkInput
 */

/** @type {Pick<Required<AgentIOHooks>, "onAskUser">} */
const DEFAULT_ACP_HOOKS = {
  onAskUser: async () => "",
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function readSessionId(value) {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.sessionId === "string") {
    return value.sessionId;
  }
  if (isRecord(value.session) && typeof value.session.id === "string") {
    return value.session.id;
  }
  return null;
}

/**
 * @param {unknown} initializeResult
 * @returns {Record<string, unknown>}
 */
function readAgentCapabilities(initializeResult) {
  if (!isRecord(initializeResult)) {
    return {};
  }
  return isRecord(initializeResult.agentCapabilities) ? initializeResult.agentCapabilities : {};
}

/**
 * @param {Record<string, unknown>} capabilities
 * @returns {Record<string, unknown>}
 */
function buildCapabilityErrorDetails(capabilities) {
  return {
    agentCapabilities: capabilities,
    required: {
      resume: "agentCapabilities.sessionCapabilities.resume",
      fork: "agentCapabilities.session.fork or agentCapabilities.sessionCapabilities.fork",
      usage: "RFD session-usage PromptResponse.usage or session/update usage_update",
      liveInput: "provider extension agentCapabilities.sessionCapabilities.steer",
    },
  };
}

/**
 * @typedef {{
 *   type: "text",
 *   text: string,
 * } | {
 *   type: "image",
 *   data: string,
 *   mimeType: string,
 *   uri?: string,
 * } | {
 *   type: "resource_link",
 *   uri: string,
 *   name: string,
 *   mimeType?: string,
 *   size?: number,
 * }} AcpPromptContentBlock
 */

/**
 * @param {string} mediaPath
 * @param {string | null | undefined} workdir
 * @returns {string}
 */
function resolvePromptMediaPath(mediaPath, workdir) {
  if (path.isAbsolute(mediaPath)) {
    return mediaPath;
  }
  if (isValidMediaPath(mediaPath)) {
    return resolveMediaPath(mediaPath);
  }
  return path.resolve(workdir ?? process.cwd(), mediaPath);
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {string | undefined}
 */
function getPromptBlockMimeType(block) {
  return typeof block.mime_type === "string" && block.mime_type.trim()
    ? block.mime_type.trim()
    : undefined;
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @param {string | undefined} resolvedPath
 * @returns {string}
 */
function getPromptBlockName(block, resolvedPath) {
  if ("file_name" in block && typeof block.file_name === "string" && block.file_name.trim()) {
    return block.file_name.trim();
  }
  if (resolvedPath) {
    return path.basename(resolvedPath);
  }
  return `${block.type}`;
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @param {string | null | undefined} workdir
 * @returns {Promise<AcpPromptContentBlock | null>}
 */
async function buildAttachmentPromptContent(block, workdir) {
  if (block.type === "image") {
    const mimeType = getPromptBlockMimeType(block) ?? "image/png";
    if (hasInlineMediaData(block)) {
      return {
        type: "image",
        data: block.data,
        mimeType,
      };
    }
    if (hasMediaPath(block)) {
      const resolvedPath = resolvePromptMediaPath(block.path, workdir);
      return {
        type: "image",
        data: (await fs.readFile(resolvedPath)).toString("base64"),
        mimeType,
      };
    }
    return null;
  }

  if (!hasMediaPath(block)) {
    return null;
  }

  const resolvedPath = resolvePromptMediaPath(block.path, workdir);
  const stats = await fs.stat(resolvedPath).catch(() => null);
  return {
    type: "resource_link",
    uri: pathToFileURL(resolvedPath).href,
    name: getPromptBlockName(block, resolvedPath),
    ...(getPromptBlockMimeType(block) ? { mimeType: getPromptBlockMimeType(block) } : {}),
    ...(stats?.isFile() ? { size: stats.size } : {}),
  };
}

/**
 * @param {string} prompt
 * @param {IncomingContentBlock[] | undefined} attachments
 * @param {string | null | undefined} [workdir]
 * @returns {Promise<AcpPromptContentBlock[]>}
 */
export async function buildAcpPromptContent(prompt, attachments, workdir) {
  /** @type {AcpPromptContentBlock[]} */
  const content = [{ type: "text", text: prompt }];
  for (const block of attachments ?? []) {
    if (block.type !== "image" && block.type !== "video" && block.type !== "audio" && block.type !== "file") {
      continue;
    }
    const attachmentContent = await buildAttachmentPromptContent(block, workdir);
    if (attachmentContent) {
      content.push(attachmentContent);
    }
  }
  return content;
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {Record<string, unknown>}
 */
function buildSessionParams(runConfig) {
  return {
    cwd: runConfig?.workdir ? path.resolve(runConfig.workdir) : process.cwd(),
    mcpServers: [],
    _meta: {
      madabot: {
        ...(runConfig?.model ? { model: runConfig.model } : {}),
        ...(runConfig?.reasoningEffort ? { reasoningEffort: runConfig.reasoningEffort } : {}),
        ...(runConfig?.sandboxMode ? { sandboxMode: runConfig.sandboxMode } : {}),
        ...(runConfig?.approvalPolicy ? { approvalPolicy: runConfig.approvalPolicy } : {}),
        ...(runConfig?.approvalsReviewer ? { approvalsReviewer: runConfig.approvalsReviewer } : {}),
        ...(runConfig?.additionalDirectories ? { additionalDirectories: runConfig.additionalDirectories } : {}),
        ...(runConfig?.protectedPaths ? { protectedPaths: runConfig.protectedPaths } : {}),
      },
    },
  };
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {boolean}
 */
function hasProtectedPathPolicy(runConfig) {
  return getProtectedPathPatterns(runConfig).length > 0;
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {string | null}
 */
function getDesiredSessionMode(runConfig) {
  if (typeof runConfig?.mode === "string" && runConfig.mode.trim()) {
    return runConfig.mode;
  }
  return hasProtectedPathPolicy(runConfig) ? "read-only" : null;
}

/**
 * @returns {Record<string, unknown>}
 */
function buildClientCapabilities() {
  return {
    fs: {
      readTextFile: true,
      writeTextFile: true,
    },
    terminal: true,
    elicitation: {
      form: {},
      url: {},
    },
    sessionCapabilities: {
      resume: {},
      fork: {},
      steer: {},
    },
    _meta: {
      subagentMessages: true,
      fileChangeEvents: true,
      sessionUsageRfd: true,
      sessionForkRfd: true,
      liveInputExtension: true,
      sessionReadRfd: true,
      sessionRollbackRfd: true,
    },
  };
}

/**
 * @param {unknown} content
 * @returns {string[]}
 */
function extractDiffContentPaths(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(isRecord)
    .filter((block) => block.type === "diff" && typeof block.path === "string" && block.path.length > 0)
    .map((block) => /** @type {string} */ (block.path));
}

/**
 * @param {Record<string, unknown>} update
 * @param {Map<string, string[]>} pendingEditDiffPaths
 * @returns {void}
 */
function rememberPendingEditDiffPaths(update, pendingEditDiffPaths) {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return;
  }
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
  if (!toolCallId || update.kind !== "edit") {
    return;
  }
  const paths = extractDiffContentPaths(update.content);
  if (paths.length > 0) {
    pendingEditDiffPaths.set(toolCallId, paths);
  }
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string | null}
 */
function readApplyPatchToolCallId(update) {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return null;
  }
  if (update.kind !== "edit") {
    return null;
  }
  return typeof update.toolCallId === "string" && update.toolCallId
    ? update.toolCallId
    : null;
}

/**
 * @param {Record<string, unknown>} update
 * @returns {boolean}
 */
function isTerminalApplyPatchUpdate(update) {
  return update.status === "completed" || update.status === "failed" || update.status === "cancelled";
}

/**
 * @param {Record<string, unknown>} update
 * @returns {string}
 */
function getApplyPatchSummary(update) {
  return typeof update.title === "string" && update.title.trim()
    ? update.title.trim()
    : "apply_patch";
}

/**
 * @param {Record<string, unknown>} update
 * @param {Map<string, {
 *   before: Map<string, string>,
 *   paths: string[],
 *   summary: string,
 * }>} pendingApplyPatchSnapshots
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {Promise<void>}
 */
async function rememberApplyPatchSnapshot(update, pendingApplyPatchSnapshots, runConfig) {
  const toolCallId = readApplyPatchToolCallId(update);
  if (!toolCallId || pendingApplyPatchSnapshots.has(toolCallId)) {
    return;
  }
  const paths = extractApplyPatchTargetPaths(update.rawInput);
  if (paths.length === 0) {
    return;
  }
  const before = await snapshotAcpPaths(runConfig?.workdir, paths);
  pendingApplyPatchSnapshots.set(toolCallId, {
    before,
    paths,
    summary: getApplyPatchSummary(update),
  });
}

/**
 * @param {Record<string, unknown>} update
 * @param {Map<string, {
 *   before: Map<string, string>,
 *   paths: string[],
 *   summary: string,
 * }>} pendingApplyPatchSnapshots
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {Set<string>} emittedFileChangePaths
 * @param {(event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>} emitRuntimeEvent
 * @returns {Promise<void>}
 */
async function emitTerminalApplyPatchFileChanges(
  update,
  pendingApplyPatchSnapshots,
  runConfig,
  emittedFileChangePaths,
  emitRuntimeEvent,
) {
  const toolCallId = readApplyPatchToolCallId(update);
  if (!toolCallId || !isTerminalApplyPatchUpdate(update)) {
    return;
  }
  const snapshot = pendingApplyPatchSnapshots.get(toolCallId);
  if (!snapshot) {
    return;
  }
  pendingApplyPatchSnapshots.delete(toolCallId);
  const after = await snapshotAcpPaths(runConfig?.workdir, snapshot.paths);
  const events = collectAcpTargetedFileChanges({
    before: snapshot.before,
    after,
    emittedPaths: emittedFileChangePaths,
    summary: snapshot.summary,
    diagnosticRaw: createAcpRawPayload("session/update", { update }),
  });
  for (const event of events) {
    await emitRuntimeEvent(event);
  }
}

/**
 * @param {unknown} result
 * @returns {Record<string, unknown>[]}
 */
function extractConfigOptions(result) {
  if (!isRecord(result) || !Array.isArray(result.configOptions)) {
    return [];
  }
  return result.configOptions.filter(isRecord);
}

/**
 * @param {unknown} result
 * @returns {{ currentModelId?: string, availableModels: Array<{ modelId: string, name: string, description?: string }> } | null}
 */
function extractModelState(result) {
  if (!isRecord(result) || !isRecord(result.models)) {
    return null;
  }
  const currentModelId = typeof result.models.currentModelId === "string"
    ? result.models.currentModelId
    : undefined;
  const availableModels = Array.isArray(result.models.availableModels)
    ? result.models.availableModels
      .filter(isRecord)
      .map((model) => ({
        modelId: typeof model.modelId === "string" ? model.modelId : "",
        name: typeof model.name === "string" ? model.name : "",
        ...(typeof model.description === "string" ? { description: model.description } : {}),
      }))
      .filter((model) => model.modelId && model.name)
    : [];
  return availableModels.length > 0 ? { ...(currentModelId ? { currentModelId } : {}), availableModels } : null;
}

/**
 * @param {unknown} result
 * @returns {{ configOptions: Record<string, unknown>[], modelState: ReturnType<typeof extractModelState> }}
 */
function extractSessionControlState(result) {
  return {
    configOptions: extractConfigOptions(result),
    modelState: extractModelState(result),
  };
}

/**
 * @param {Record<string, unknown>} option
 * @returns {Array<{ value: string, name: string }>}
 */
function flattenSelectOptions(option) {
  if (!Array.isArray(option.options)) {
    return [];
  }
  /** @type {Array<{ value: string, name: string }>} */
  const values = [];
  for (const item of option.options) {
    if (!isRecord(item)) {
      continue;
    }
    if (typeof item.value === "string" && typeof item.name === "string") {
      values.push({ value: item.value, name: item.name });
      continue;
    }
    if (Array.isArray(item.options)) {
      for (const nested of item.options.filter(isRecord)) {
        if (typeof nested.value === "string" && typeof nested.name === "string") {
          values.push({ value: nested.value, name: nested.name });
        }
      }
    }
  }
  return values;
}

/**
 * @param {Record<string, unknown>[]} options
 * @param {"model" | "thought_level" | "mode"} category
 * @returns {Record<string, unknown> | null}
 */
function findConfigOption(options, category) {
  const categoryMatch = options.find((option) => option.category === category);
  if (categoryMatch) {
    return categoryMatch;
  }
  const fallbackNames = category === "model"
    ? ["model"]
    : category === "mode" ? ["mode"] : ["effort", "reasoning", "thought"];
  return options.find((option) => {
    const id = typeof option.id === "string" ? option.id.toLowerCase() : "";
    const name = typeof option.name === "string" ? option.name.toLowerCase() : "";
    return fallbackNames.some((candidate) => id.includes(candidate) || name.includes(candidate));
  }) ?? null;
}

/**
 * @param {Record<string, unknown>} option
 * @param {string} desired
 * @returns {string | boolean | null}
 */
function resolveConfigValue(option, desired) {
  const normalizedDesired = desired.trim().toLowerCase();
  if (option.type === "boolean") {
    if (["true", "yes", "on", "1"].includes(normalizedDesired)) return true;
    if (["false", "no", "off", "0"].includes(normalizedDesired)) return false;
  }
  const values = flattenSelectOptions(option);
  const match = values.find((value) => value.value.toLowerCase() === normalizedDesired)
    ?? values.find((value) => value.name.toLowerCase() === normalizedDesired);
  return match?.value ?? (values.length === 0 ? desired : null);
}

/**
 * @param {{
 *   connection: Awaited<ReturnType<typeof openAcpConnection>>,
 *   sessionId: string | null,
 *   configOptions: Record<string, unknown>[],
 *   runConfig?: HarnessRunConfig,
 * }} input
 * @returns {Promise<void>}
 */
async function applySessionConfigOptions(input) {
  if (!input.sessionId) {
    return;
  }
  const customConfigValues = isRecord(input.runConfig?.configValues) ? input.runConfig.configValues : {};
  const targets = [
    { category: /** @type {"model"} */ ("model"), desired: input.runConfig?.model ?? null },
    { category: /** @type {"mode"} */ ("mode"), desired: getDesiredSessionMode(input.runConfig) },
    { category: /** @type {"thought_level"} */ ("thought_level"), desired: input.runConfig?.reasoningEffort ?? null },
  ];
  for (const target of targets) {
    if (!target.desired) {
      continue;
    }
    const option = findConfigOption(input.configOptions, target.category);
    if (!option || typeof option.id !== "string") {
      continue;
    }
    const value = resolveConfigValue(option, target.desired);
    if (value === null || value === option.currentValue) {
      continue;
    }
    await input.connection.sendRequest("session/set_config_option", {
      sessionId: input.sessionId,
      configId: option.id,
      ...(typeof value === "boolean" ? { type: "boolean" } : {}),
      value,
    }, { timeoutMs: ACP_SESSION_REQUEST_TIMEOUT_MS });
  }
  for (const [configId, desired] of Object.entries(customConfigValues)) {
    if (desired === null || desired === undefined) {
      continue;
    }
    const option = input.configOptions.find((candidate) => candidate.id === configId);
    if (!option || typeof option.id !== "string") {
      continue;
    }
    const value = typeof desired === "boolean" ? desired : resolveConfigValue(option, String(desired));
    if (value === null || value === option.currentValue) {
      continue;
    }
    await input.connection.sendRequest("session/set_config_option", {
      sessionId: input.sessionId,
      configId: option.id,
      ...(typeof value === "boolean" ? { type: "boolean" } : {}),
      value,
    }, { timeoutMs: ACP_SESSION_REQUEST_TIMEOUT_MS });
  }
}

/**
 * @param {Record<string, unknown>[]} options
 * @returns {Record<string, unknown>[]}
 */
function normalizeConfigOptions(options) {
  return options
    .filter((option) => typeof option.id === "string" && typeof option.name === "string")
    .filter((option) => option.type === "select" || option.type === "boolean" || Array.isArray(option.options));
}

/**
 * @param {AcpForkInput} input
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function getAcpSessionConfigOptions(input) {
  const state = await getAcpSessionControlState(input);
  return state.configOptions;
}

/**
 * @param {AcpForkInput} input
 * @returns {Promise<{ configOptions: Record<string, unknown>[], modelState: ReturnType<typeof extractModelState> }>}
 */
export async function getAcpSessionControlState(input) {
  const { connection, capabilities } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    let opened;
    if (hasAcpSessionCapability(capabilities, "resume")) {
      opened = await connection.sendRequest("session/resume", {
        sessionId: input.sessionId,
        ...buildSessionParams(input.runConfig),
      });
    } else if (supportsAcpLoadSession(capabilities)) {
      opened = await connection.sendRequest("session/load", {
        sessionId: input.sessionId,
        ...buildSessionParams(input.runConfig),
      });
    } else {
      return { configOptions: [], modelState: null };
    }
    const state = extractSessionControlState(opened);
    return { ...state, configOptions: normalizeConfigOptions(state.configOptions) };
  } finally {
    await connection.close();
  }
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   runConfig?: HarnessRunConfig,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function getAcpInitialSessionConfigOptions(input) {
  const state = await getAcpInitialSessionControlState(input);
  return state.configOptions;
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   runConfig?: HarnessRunConfig,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ configOptions: Record<string, unknown>[], modelState: ReturnType<typeof extractModelState> }>}
 */
export async function getAcpInitialSessionControlState(input) {
  const { connection } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    const opened = await connection.sendRequest("session/new", buildSessionParams(input.runConfig));
    const state = extractSessionControlState(opened);
    return { ...state, configOptions: normalizeConfigOptions(state.configOptions) };
  } finally {
    await connection.close();
  }
}

/**
 * @param {AcpForkInput & { configId: string, value: string | boolean }} input
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function setAcpSessionConfigOption(input) {
  const { connection, capabilities } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    if (hasAcpSessionCapability(capabilities, "resume")) {
      await connection.sendRequest("session/resume", {
        sessionId: input.sessionId,
        ...buildSessionParams(input.runConfig),
      });
    } else if (supportsAcpLoadSession(capabilities)) {
      await connection.sendRequest("session/load", {
        sessionId: input.sessionId,
        ...buildSessionParams(input.runConfig),
      });
    }
    const result = await connection.sendRequest("session/set_config_option", {
      sessionId: input.sessionId,
      configId: input.configId,
      ...(typeof input.value === "boolean" ? { type: "boolean" } : {}),
      value: input.value,
    });
    return normalizeConfigOptions(extractConfigOptions(result));
  } finally {
    await connection.close();
  }
}

/**
 * @param {AcpForkInput & { modelId: string }} input
 * @returns {Promise<void>}
 */
export async function setAcpSessionModel(input) {
  const { connection, capabilities } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    if (hasAcpSessionCapability(capabilities, "resume")) {
      await connection.sendRequest("session/resume", {
        sessionId: input.sessionId,
        ...buildSessionParams(input.runConfig),
      });
    } else if (supportsAcpLoadSession(capabilities)) {
      await connection.sendRequest("session/load", {
        sessionId: input.sessionId,
        ...buildSessionParams(input.runConfig),
      });
    }
    await connection.sendRequest("session/set_model", {
      sessionId: input.sessionId,
      modelId: input.modelId,
    });
  } finally {
    await connection.close();
  }
}

/**
 * @param {AcpRunInput} input
 * @param {ReturnType<typeof createHarnessRuntimeEventDispatcher>} runtimeDispatcher
 * @param {unknown} promptResult
 * @returns {Promise<void>}
 */
async function handlePromptUsage(input, runtimeDispatcher, promptResult) {
  if (!isRecord(promptResult) || !isRecord(promptResult.usage)) {
    return;
  }
  const event = /** @type {import("./harness-runtime-events.js").HarnessRuntimeEventInput} */ ({
    type: "usage.updated",
    provider: "acp",
    usage: normalizeAcpUsage(promptResult.usage),
    diagnosticRaw: { promptResult },
  });
  input.emitEvent?.(event);
  await runtimeDispatcher.handleEvent(event);
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   runConfig?: HarnessRunConfig,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 * }} input
 * @param {(message: Record<string, unknown>) => Promise<unknown>} [handleRequest]
 * @returns {Promise<{ connection: Awaited<ReturnType<typeof openAcpConnection>>, capabilities: Record<string, unknown> }>}
 */
async function openInitializedAcpConnection(input, handleRequest = async () => ({})) {
  const resolvedCommand = resolveAcpCommandPath(input.command);
  log.info("Opening ACP connection", {
    command: input.command,
    resolvedCommand,
    args: input.args ?? [],
    workdir: input.runConfig?.workdir ?? null,
  });
  const connection = await openAcpConnection({
    command: input.command,
    args: input.args,
    cwd: input.runConfig?.workdir ?? undefined,
    env: input.env,
    signal: input.signal,
    handleRequest,
  });
  log.info("ACP initialize request starting", {
    command: input.command,
    resolvedCommand,
    workdir: input.runConfig?.workdir ?? null,
  });
  const initializeResult = await connection.sendRequest("initialize", {
    protocolVersion: 1,
    clientInfo: {
      name: "madabot",
      title: "Madabot",
      version: "1.0.0",
    },
    clientCapabilities: buildClientCapabilities(),
  }, { timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS });
  const capabilities = readAgentCapabilities(initializeResult);
  log.info("ACP initialize request completed", {
    command: input.command,
    resolvedCommand,
    capabilityKeys: Object.keys(capabilities).join(","),
  });
  return {
    connection,
    capabilities,
  };
}

/**
 * @param {AcpForkInput} input
 * @returns {Promise<string>}
 */
export async function forkAcpSession(input) {
  const { connection, capabilities } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    if (!hasAcpSessionCapability(capabilities, "fork")) {
      throw new Error("ACP agent does not advertise session/fork capability.");
    }
    const forked = await connection.sendRequest("session/fork", {
      sessionId: input.sessionId,
      ...buildSessionParams(input.runConfig),
    });
    const forkedSessionId = readSessionId(forked);
    if (!forkedSessionId) {
      throw new Error("ACP session/fork did not return a sessionId.");
    }
    return forkedSessionId;
  } finally {
    await connection.close();
  }
}

/**
 * @param {AcpForkInput & { numTurns: number }} input
 * @returns {Promise<unknown>}
 */
export async function rollbackAcpSession(input) {
  const { connection, capabilities } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    if (!hasAcpSessionCapability(capabilities, "rollback") && !hasMadabotAcpSessionCapability(capabilities, "rollback")) {
      return null;
    }
    return await connection.sendRequest("session/rollback", {
      sessionId: input.sessionId,
      numTurns: input.numTurns,
    });
  } finally {
    await connection.close();
  }
}

/**
 * @param {AcpRunInput} input
 * @returns {Promise<{ result: AgentResult, sessionId: string | null, capabilities: Record<string, unknown> }>}
 */
export async function startAcpRun(input) {
  log.info("ACP runner startAcpRun entered", {
    sessionId: input.sessionId ?? null,
    promptLength: input.prompt.length,
    workdir: input.runConfig?.workdir ?? null,
  });
  const hooks = { ...DEFAULT_ACP_HOOKS, ...input.hooks };
  const runtimeHooks = input.dispatchRuntimeEventsToHooks === false
    ? {}
    : input.hooks ?? {};
  const runtimeDispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: input.messages ?? [],
    hooks: runtimeHooks,
    emitRuntimeEvent: async (event) => {
      await runtimeHooks.onRuntimeEvent?.(event);
    },
    workdir: input.runConfig?.workdir ?? null,
  });
  const snapshotFileChangesEnabled = input.runConfig?.snapshotFileChanges !== false;
  /** @type {Map<string, string> | null} */
  let beforeSnapshot = null;
  if (snapshotFileChangesEnabled) {
    const beforeSnapshotStartedAt = Date.now();
    log.info("ACP before workdir snapshot starting", {
      workdir: input.runConfig?.workdir ?? null,
    });
    beforeSnapshot = await snapshotAcpWorkdir(input.runConfig?.workdir);
    log.info("ACP before workdir snapshot completed", {
      workdir: input.runConfig?.workdir ?? null,
      fileCount: beforeSnapshot?.size ?? 0,
      durationMs: Date.now() - beforeSnapshotStartedAt,
    });
  }
  const reconciliationBaseline = beforeSnapshot ? new Map(beforeSnapshot) : new Map();
  /** @type {Set<string>} */
  const emittedFileChangePaths = new Set();
  /** @type {Set<string>} */
  const approvedProtectedPaths = new Set();
  /** @type {Map<string, string[]>} */
  const pendingEditDiffPaths = new Map();
  /** @type {Map<string, {
   *   before: Map<string, string>,
   *   paths: string[],
   *   summary: string,
   * }>} */
  const pendingApplyPatchSnapshots = new Map();
  const runtimeModel = createAcpRuntimeModel();
  const emitRuntimeEvent = async (/** @type {import("./harness-runtime-events.js").HarnessRuntimeEventInput} */ event) => {
    const reconciled = reconcileAcpFileChangeWithBaseline(event, reconciliationBaseline, input.runConfig?.workdir);
    if (reconciled.type === "file-change.completed") {
      const protectedMatch = matchProtectedPath(input.runConfig, reconciled.change.path);
      if (protectedMatch.protected && approvedProtectedPaths.has(protectedMatch.resolvedPath)) {
        emittedFileChangePaths.add(resolveAcpFileChangePath(input.runConfig?.workdir, reconciled.change.path));
        if (isAcpFileChangeIgnored(input.runConfig, reconciled.change.path)) {
          return;
        }
        updateAcpFileChangeBaseline(reconciliationBaseline, reconciled, input.runConfig?.workdir);
        input.emitEvent?.(reconciled);
        await runtimeDispatcher.handleEvent(reconciled);
        return;
      }
      const protectedApproval = await requestProtectedPathApproval({
        runConfig: input.runConfig,
        filePath: reconciled.change.path,
        action: "ACP file change",
        hooks,
      });
      if (protectedApproval.match.protected && !protectedApproval.allowed) {
        await restoreProtectedPath({
          resolvedPath: protectedApproval.match.resolvedPath,
          oldText: reconciled.change.oldText,
          hadOldText: reconciled.change.oldText !== undefined,
        });
        const message = `Protected path change reverted: ${protectedApproval.match.relativePath}`;
        /** @type {import("./harness-runtime-events.js").HarnessRuntimeEventInput} */
        const failureEvent = {
          type: "tool.failed",
          provider: "acp",
          tool: {
            id: `protected-path:${protectedApproval.match.relativePath}`,
            name: "protected_path",
            arguments: { path: protectedApproval.match.relativePath },
            output: message,
          },
          diagnosticRaw: reconciled.diagnosticRaw,
        };
        input.emitEvent?.(failureEvent);
        await runtimeDispatcher.handleEvent(failureEvent);
        return;
      }
      if (protectedApproval.match.protected) {
        approvedProtectedPaths.add(protectedApproval.match.resolvedPath);
      }
    }
    if (reconciled.type === "file-change.completed") {
      emittedFileChangePaths.add(resolveAcpFileChangePath(input.runConfig?.workdir, reconciled.change.path));
      if (isAcpFileChangeIgnored(input.runConfig, reconciled.change.path)) {
        return;
      }
      updateAcpFileChangeBaseline(reconciliationBaseline, reconciled, input.runConfig?.workdir);
    }
    input.emitEvent?.(reconciled);
    await runtimeDispatcher.handleEvent(reconciled);
  };
  const handleRequest = createAcpClientRequestHandler({
    hooks,
    runConfig: input.runConfig,
    emitRuntimeEvent,
    requestDecision: input.requestDecision,
    userInputDecision: input.userInputDecision,
    approvedProtectedPaths,
    pendingEditDiffPaths,
  });
  const { connection, capabilities } = await openInitializedAcpConnection(input, handleRequest);
  let sessionId = input.sessionId ?? null;
  let promptCompleted = false;
  let connectionClosed = false;
  /** @type {Record<string, unknown>[]} */
  let configOptions = [];
  /** @type {void | (() => void)} */
  let unregisterActiveRun = undefined;

  const extensionRouter = createAcpExtensionRouter({
    emitRuntimeEvent,
    createRawPayload: createAcpRawPayload,
  });

  const notificationsDone = (async () => {
    for await (const message of connection.notifications) {
      if (message.method !== "session/update" || !isRecord(message.params)) {
        await extensionRouter.handleNotification(message);
        continue;
      }
      const update = isRecord(message.params.update) ? message.params.update : null;
      if (update) {
        rememberPendingEditDiffPaths(update, pendingEditDiffPaths);
        await rememberApplyPatchSnapshot(update, pendingApplyPatchSnapshots, input.runConfig);
      }
      const events = runtimeModel.acceptSessionUpdate(message.params);
      for (const event of events) {
        await emitRuntimeEvent(event);
      }
      if (update) {
        await emitTerminalApplyPatchFileChanges(
          update,
          pendingApplyPatchSnapshots,
          input.runConfig,
          emittedFileChangePaths,
          emitRuntimeEvent,
        );
      }
    }
  })();

  try {
    if (sessionId) {
      if (hasAcpSessionCapability(capabilities, "resume")) {
        log.info("ACP session/resume request starting", { sessionId });
        const resumed = await connection.sendRequest("session/resume", {
          sessionId,
          ...buildSessionParams(input.runConfig),
        }, { timeoutMs: ACP_SESSION_REQUEST_TIMEOUT_MS });
        sessionId = readSessionId(resumed) ?? sessionId;
        configOptions = extractConfigOptions(resumed);
        log.info("ACP session/resume request completed", { sessionId });
      } else if (supportsAcpLoadSession(capabilities)) {
        log.info("ACP session/load request starting", { sessionId });
        const loaded = await connection.sendRequest("session/load", {
          sessionId,
          ...buildSessionParams(input.runConfig),
        }, { timeoutMs: ACP_SESSION_REQUEST_TIMEOUT_MS });
        sessionId = readSessionId(loaded) ?? sessionId;
        configOptions = extractConfigOptions(loaded);
        log.info("ACP session/load request completed", { sessionId });
      } else {
        throw new Error(`ACP agent does not advertise required session resume capability: ${JSON.stringify(buildCapabilityErrorDetails(capabilities))}`);
      }
    } else {
      log.info("ACP session/new request starting");
      const created = await connection.sendRequest(
        "session/new",
        buildSessionParams(input.runConfig),
        { timeoutMs: ACP_SESSION_REQUEST_TIMEOUT_MS },
      );
      sessionId = readSessionId(created);
      configOptions = extractConfigOptions(created);
      log.info("ACP session/new request completed", { sessionId });
    }
    log.info("ACP session config apply starting", {
      sessionId,
      configOptionCount: configOptions.length,
    });
    await applySessionConfigOptions({ connection, sessionId, configOptions, runConfig: input.runConfig });
    log.info("ACP session config apply completed", { sessionId });
    unregisterActiveRun = input.onActiveRun?.({ connection, sessionId, capabilities });

    log.info("ACP session/prompt request starting", {
      sessionId,
      promptLength: input.prompt.length,
      attachmentCount: input.attachments?.length ?? 0,
    });
    const promptResult = await connection.sendRequest("session/prompt", {
      ...(sessionId ? { sessionId } : {}),
      prompt: await buildAcpPromptContent(input.prompt, input.attachments, input.runConfig?.workdir),
    }, { timeoutMs: ACP_PROMPT_TIMEOUT_MS, refreshOnActivity: true });
    sessionId = readSessionId(promptResult) ?? sessionId;
    log.info("ACP session/prompt request completed", { sessionId });
    await handlePromptUsage(input, runtimeDispatcher, promptResult);
    unregisterActiveRun?.();
    unregisterActiveRun = undefined;
    await connection.close();
    connectionClosed = true;
    await notificationsDone.catch(() => {});
    for (const event of runtimeModel.flushAssistantSegment()) {
      await emitRuntimeEvent(event);
    }
    if (snapshotFileChangesEnabled) {
      const afterSnapshotStartedAt = Date.now();
      log.info("ACP after workdir snapshot starting", {
        workdir: input.runConfig?.workdir ?? null,
      });
      const afterSnapshot = await snapshotAcpWorkdir(input.runConfig?.workdir);
      log.info("ACP after workdir snapshot completed", {
        workdir: input.runConfig?.workdir ?? null,
        fileCount: afterSnapshot?.size ?? 0,
        durationMs: Date.now() - afterSnapshotStartedAt,
      });
      const snapshotFileChanges = collectAcpSnapshotFileChanges({
        before: beforeSnapshot,
        after: afterSnapshot,
        emittedPaths: emittedFileChangePaths,
      });
      await emitAcpSnapshotFileChangeEvents(snapshotFileChanges, emitRuntimeEvent);
    }
    promptCompleted = true;
    return {
      result: runtimeDispatcher.result,
      sessionId,
      capabilities,
    };
  } finally {
    unregisterActiveRun?.();
    if (!connectionClosed) {
      await connection.close();
      await notificationsDone.catch(() => {});
      for (const event of runtimeModel.flushAssistantSegment()) {
        await emitRuntimeEvent(event);
      }
    }
    if (!promptCompleted && !runtimeDispatcher.result.response.length) {
      runtimeDispatcher.result.response = [];
    }
  }
}
