import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { openAcpConnection } from "./acp-client.js";
import { hasAcpSessionCapability, hasMadabotAcpSessionCapability, supportsAcpLoadSession } from "./acp-capabilities.js";
import { createAcpRawPayload, createAcpRuntimeModel, normalizeAcpUsage } from "./acp-events.js";
import {
  collectAcpSnapshotFileChanges,
  emitAcpSnapshotFileChangeEvents,
  isAcpFileChangeIgnored,
  reconcileAcpFileChangeWithBaseline,
  resolveAcpFileChangePath,
  snapshotAcpWorkdir,
} from "./acp-file-changes.js";
import { createAcpExtensionRouter } from "./acp-extension-router.js";
import { buildUnifiedFileDiff } from "./file-change-utils.js";
import { createHarnessRuntimeEventDispatcher } from "./harness-runtime-event-dispatcher.js";
import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import { requestSandboxEscapeApproval } from "./sandbox-approval-coordinator.js";
import { matchProtectedPath, requestProtectedPathApproval, restoreProtectedPath } from "./protected-paths.js";

/**
 * @typedef {{
 *   command: string,
 *   args?: string[],
 *   prompt: string,
 *   messages?: Message[],
 *   sessionId?: string | null,
 *   runConfig?: HarnessRunConfig,
 *   hooks?: AgentIOHooks,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   emitEvent?: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => void,
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

/**
 * @typedef {{
 *   proc: import("node:child_process").ChildProcess,
 *   command: string,
 *   output: string,
 *   outputByteLimit?: number | null,
 *   exitStatus: { exitCode: number | null, signal: string | null } | null,
 *   exitPromise: Promise<{ exitCode: number | null, signal: string | null }>,
 * }} AcpTerminal
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
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function paramsRecord(value) {
  return isRecord(value) ? value : {};
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
 * @param {string} prompt
 * @returns {Array<{ type: "text", text: string }>}
 */
function buildPromptContent(prompt) {
  return [{ type: "text", text: prompt }];
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
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * @param {unknown} value
 * @returns {{ name: string, value: string }[]}
 */
function normalizeEnvVariables(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      value: typeof entry.value === "string" ? entry.value : "",
    }))
    .filter((entry) => entry.name.length > 0);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function formatCommandLine(command, args) {
  return [command, ...args].join(" ");
}

/**
 * @param {string} output
 * @param {number | null | undefined} limit
 * @returns {{ output: string, truncated: boolean }}
 */
function truncateTerminalOutput(output, limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return { output, truncated: false };
  }
  const bytes = Buffer.byteLength(output);
  if (bytes <= limit) {
    return { output, truncated: false };
  }
  let truncated = output;
  while (Buffer.byteLength(truncated) > limit && truncated.length > 0) {
    truncated = truncated.slice(Math.max(1, truncated.length - Math.ceil(truncated.length * 0.9)));
  }
  return { output: truncated, truncated: true };
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {string | null | undefined} fallbackCwd
 * @returns {string}
 */
function resolveRequestCwd(runConfig, fallbackCwd) {
  if (typeof fallbackCwd === "string" && fallbackCwd.trim()) {
    return path.resolve(fallbackCwd);
  }
  if (typeof runConfig?.workdir === "string" && runConfig.workdir.trim()) {
    return path.resolve(runConfig.workdir);
  }
  return process.cwd();
}

/**
 * @param {{
 *   toolName: string,
 *   input: Record<string, unknown>,
 *   runConfig?: HarnessRunConfig,
 *   cwd: string,
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 * }} input
 * @returns {Promise<void>}
 */
async function assertSandboxAccess(input) {
  const request = getSandboxEscapeRequest(input.toolName, input.input, {
    workdir: input.runConfig?.workdir ?? input.cwd,
    sandboxMode: input.runConfig?.sandboxMode ?? "workspace-write",
    additionalWritableRoots: input.runConfig?.additionalDirectories ?? null,
  });
  if (!request) {
    return;
  }
  const allowed = await requestSandboxEscapeApproval(request, input.hooks.onAskUser);
  if (!allowed) {
    throw new Error(`User denied sandbox escape for ${input.toolName}.`);
  }
}

/**
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 *   requestDecision?: (request: { id: string, title: string, labels: string[], descriptions: string[] }) => Promise<string | null>,
 *   userInputDecision?: (request: import("./harness-runtime-events.js").HarnessRuntimeUserInputRequest) => Promise<unknown>,
 *   approvedProtectedPaths?: Set<string>,
 * }} options
 */
function createAcpClientRequestHandler(options) {
  const terminals = createAcpTerminalManager(options);
  /** @type {Map<string, (message: Record<string, unknown>) => Promise<unknown> | unknown>} */
  const requestHandlers = new Map();
  requestHandlers.set("session/request_permission", (message) => handleAcpPermissionRequest(message, options));
  requestHandlers.set("elicitation/create", (message) => handleAcpElicitationCreate(message, options));
  requestHandlers.set("fs/read_text_file", (message) => handleAcpReadTextFile(message, options));
  requestHandlers.set("fs/write_text_file", (message) => handleAcpWriteTextFile(message, options));
  requestHandlers.set("terminal/create", (message) => terminals.create(message));
  requestHandlers.set("terminal/output", (message) => terminals.output(message));
  requestHandlers.set("terminal/wait_for_exit", (message) => terminals.waitForExit(message));
  requestHandlers.set("terminal/kill", (message) => terminals.kill(message));
  requestHandlers.set("terminal/release", (message) => terminals.release(message));
  const router = createAcpExtensionRouter({
    requestHandlers,
    emitRuntimeEvent: options.emitRuntimeEvent,
    createRawPayload: createAcpRawPayload,
  });
  return async (/** @type {Record<string, unknown>} */ message) => {
    return router.handleRequest(message);
  };
}

/**
 * @param {Record<string, unknown>} message
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 *   requestDecision?: (request: { id: string, title: string, labels: string[], descriptions: string[] }) => Promise<string | null>,
 * }} options
 * @returns {Promise<{ outcome: { outcome: "selected", optionId: string } | { outcome: "cancelled" } }>}
 */
async function handleAcpPermissionRequest(message, options) {
  const params = paramsRecord(message.params);
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
  const requestOptions = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
  if (requestOptions.length === 0) {
    return { outcome: { outcome: "cancelled" } };
  }
  const labels = requestOptions.map((option) => typeof option.name === "string" ? option.name : String(option.optionId ?? "Option"));
  const descriptions = requestOptions.map((option) => typeof option.kind === "string" ? option.kind : "");
  const title = typeof toolCall.title === "string" && toolCall.title.trim()
    ? toolCall.title.trim()
    : "tool call";
  const id = typeof message.id === "number" || typeof message.id === "string"
    ? `acp-request:${message.id}`
    : `acp-request:${Date.now()}`;
  await options.emitRuntimeEvent({
    type: "request.opened",
    provider: "acp",
    request: {
      id,
      kind: "tool-user-input",
      summary: title,
      detail: labels.join(", "),
    },
    raw: createAcpRawPayload("session/request_permission", message.params),
  });
  const hookDecision = options.hooks.onAskUser(`Allow *${title}*?`, labels, undefined, descriptions);
  const externalDecision = options.requestDecision?.({ id, title, labels, descriptions });
  const choice = await (externalDecision
    ? Promise.race([externalDecision, hookDecision])
    : hookDecision);
  const selected = requestOptions.find((option, index) => choice === labels[index] || choice === option.optionId)
    ?? requestOptions.find((option) => option.kind === "reject_once" || option.kind === "reject_always")
    ?? requestOptions[0];
  const optionId = typeof selected?.optionId === "string" ? selected.optionId : null;
  await options.emitRuntimeEvent({
    type: "request.resolved",
    provider: "acp",
    request: {
      id,
      kind: "tool-user-input",
      summary: optionId ? `selected:${optionId}` : "cancelled",
    },
    raw: createAcpRawPayload("session/request_permission", { optionId }),
  });
  return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function labelFromSchemaValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * @param {Record<string, unknown>} schema
 * @returns {Array<{ label: string, value: unknown, description?: string }>}
 */
function enumOptionsFromSchema(schema) {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter(isRecord)
      .filter((item) => "const" in item)
      .map((item) => ({
        label: typeof item.title === "string" ? item.title : labelFromSchemaValue(item.const),
        value: item.const,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      }));
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.filter(isRecord)
      .filter((item) => "const" in item)
      .map((item) => ({
        label: typeof item.title === "string" ? item.title : labelFromSchemaValue(item.const),
        value: item.const,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      }));
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => ({ label: labelFromSchemaValue(value), value }));
  }
  if (schema.type === "boolean") {
    return [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ];
  }
  return [];
}

/**
 * @param {Record<string, unknown>} schema
 * @returns {Array<{ id: string, question: string, options: Array<{ label: string, description?: string }>, values: Map<string, unknown>, defaultValue?: unknown }>}
 */
function buildElicitationQuestions(schema) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const questions = [];
  for (const [id, rawProperty] of Object.entries(properties)) {
    if (!isRecord(rawProperty)) {
      continue;
    }
    const options = enumOptionsFromSchema(rawProperty);
    const values = new Map();
    const promptOptions = options.length > 0
      ? options.map((option) => {
          values.set(option.label, option.value);
          return {
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          };
        })
      : [{ label: "Use default" }, { label: "Decline" }];
    const question = typeof rawProperty.title === "string" && rawProperty.title.trim()
      ? rawProperty.title.trim()
      : id;
    questions.push({
      id,
      question,
      options: promptOptions,
      values,
      ...("default" in rawProperty ? { defaultValue: rawProperty.default } : {}),
    });
  }
  return questions;
}

/**
 * @param {unknown} response
 * @param {Array<{ id: string }>} questions
 * @returns {{ action: "accept", content: Record<string, unknown> } | { action: "decline" } | { action: "cancel" } | null}
 */
function normalizeExternalElicitationResponse(response, questions) {
  if (isRecord(response) && typeof response.action === "string") {
    if (response.action === "decline" || response.action === "cancel") {
      return { action: response.action };
    }
    if (response.action === "accept") {
      return { action: "accept", content: isRecord(response.content) ? response.content : {} };
    }
  }
  if (isRecord(response)) {
    return { action: "accept", content: response };
  }
  if (questions.length === 1 && response !== undefined && response !== null) {
    return { action: "accept", content: { [questions[0].id]: response } };
  }
  return null;
}

/**
 * @param {Record<string, unknown>} message
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 *   userInputDecision?: (request: import("./harness-runtime-events.js").HarnessRuntimeUserInputRequest) => Promise<unknown>,
 * }} options
 * @returns {Promise<{ action: "accept", content?: Record<string, unknown> } | { action: "decline" } | { action: "cancel" }>}
 */
async function handleAcpElicitationCreate(message, options) {
  const params = paramsRecord(message.params);
  const id = typeof message.id === "number" || typeof message.id === "string"
    ? `acp-user-input:${message.id}`
    : `acp-user-input:${Date.now()}`;
  const mode = typeof params.mode === "string" ? params.mode : "form";
  const messageText = typeof params.message === "string" && params.message.trim()
    ? params.message.trim()
    : "The agent needs input.";
  const questions = mode === "url"
    ? [{
        id: typeof params.elicitationId === "string" ? params.elicitationId : "url",
        question: messageText,
        options: [
          { label: "Open/continue" },
          { label: "Decline" },
        ],
        values: new Map([["Open/continue", true], ["Decline", false]]),
      }]
    : buildElicitationQuestions(isRecord(params.requestedSchema) ? params.requestedSchema : {});
  const runtimeRequest = {
    id,
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
      options: question.options,
    })),
  };
  await options.emitRuntimeEvent({
    type: "user-input.requested",
    provider: "acp",
    request: runtimeRequest,
    raw: createAcpRawPayload("elicitation/create", message.params),
  });
  const askViaHooks = async () => {
    /** @type {Record<string, unknown>} */
    const content = {};
    for (const question of questions) {
      const labels = question.options.map((option) => option.label);
      const descriptions = question.options.map((option) => option.description ?? "");
      const choice = await options.hooks.onAskUser(question.question || messageText, labels, messageText, descriptions);
      if (!choice || choice === "Decline") {
        return /** @type {{ action: "decline" }} */ ({ action: "decline" });
      }
      if (question.values.has(choice)) {
        content[question.id] = question.values.get(choice);
      } else if ("defaultValue" in question) {
        content[question.id] = question.defaultValue;
      } else {
        content[question.id] = choice;
      }
    }
    return /** @type {{ action: "accept", content: Record<string, unknown> }} */ ({ action: "accept", content });
  };
  const hookDecision = askViaHooks();
  const externalDecision = options.userInputDecision?.(runtimeRequest)
    .then((response) => normalizeExternalElicitationResponse(response, questions))
    .then((response) => response ?? hookDecision);
  const decision = await (externalDecision
    ? Promise.race([externalDecision, hookDecision])
    : hookDecision);
  await options.emitRuntimeEvent({
    type: "user-input.resolved",
    provider: "acp",
    request: runtimeRequest,
    raw: createAcpRawPayload("elicitation/create", decision),
  });
  return decision;
}

/**
 * @param {Record<string, unknown>} message
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 * }} options
 * @returns {Promise<{ content: string }>}
 */
async function handleAcpReadTextFile(message, options) {
  const params = paramsRecord(message.params);
  if (typeof params.path !== "string" || !path.isAbsolute(params.path)) {
    throw new Error("ACP fs/read_text_file requires an absolute path.");
  }
  const cwd = resolveRequestCwd(options.runConfig, null);
  await assertSandboxAccess({
    toolName: "read_file",
    input: { path: params.path },
    runConfig: options.runConfig,
    cwd,
    hooks: options.hooks,
  });
  const content = await fs.readFile(params.path, "utf8");
  const line = typeof params.line === "number" && Number.isFinite(params.line) ? Math.max(1, Math.floor(params.line)) : null;
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(0, Math.floor(params.limit)) : null;
  if (!line && !limit) {
    return { content };
  }
  const lines = content.split(/\r?\n/);
  const start = line ? line - 1 : 0;
  const selected = limit ? lines.slice(start, start + limit) : lines.slice(start);
  return { content: selected.join("\n") };
}

/**
 * @param {Record<string, unknown>} message
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 *   approvedProtectedPaths?: Set<string>,
 * }} options
 * @returns {Promise<Record<string, never>>}
 */
async function handleAcpWriteTextFile(message, options) {
  const params = paramsRecord(message.params);
  if (typeof params.path !== "string" || !path.isAbsolute(params.path)) {
    throw new Error("ACP fs/write_text_file requires an absolute path.");
  }
  if (typeof params.content !== "string") {
    throw new Error("ACP fs/write_text_file requires string content.");
  }
  const cwd = resolveRequestCwd(options.runConfig, null);
  await assertSandboxAccess({
    toolName: "write_file",
    input: { path: params.path },
    runConfig: options.runConfig,
    cwd,
    hooks: options.hooks,
  });
  const protectedApproval = await requestProtectedPathApproval({
    runConfig: options.runConfig,
    filePath: params.path,
    action: "ACP file write",
    hooks: options.hooks,
  });
  if (!protectedApproval.allowed) {
    throw new Error(`User denied protected path change for ${protectedApproval.match.relativePath}.`);
  }
  if (protectedApproval.match.protected) {
    options.approvedProtectedPaths?.add(protectedApproval.match.resolvedPath);
  }
  if (options.runConfig?.sandboxMode === "read-only") {
    const choice = await options.hooks.onAskUser("Allow *file write*?", ["✅ Allow", "❌ Deny"], undefined, [params.path]);
    if (choice === "❌ Deny" || !choice) {
      throw new Error("User denied file write.");
    }
  }
  let oldText;
  try {
    oldText = await fs.readFile(params.path, "utf8");
  } catch {
    oldText = undefined;
  }
  await fs.mkdir(path.dirname(params.path), { recursive: true });
  await fs.writeFile(params.path, params.content, "utf8");
  const diff = buildUnifiedFileDiff(params.path, oldText, params.content);
  await options.emitRuntimeEvent({
    type: "file-change.completed",
    provider: "acp",
    change: {
      path: params.path,
      summary: "ACP file write",
      kind: oldText === undefined ? "add" : "update",
      source: "tool",
      ...(diff ? { diff } : {}),
      ...(oldText !== undefined ? { oldText } : {}),
      newText: params.content,
    },
    raw: { message },
  });
  return {};
}

/**
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 * }} options
 */
function createAcpTerminalManager(options) {
  /** @type {Map<string, AcpTerminal>} */
  const terminals = new Map();
  let nextTerminalId = 1;

  return {
    create,
    output,
    waitForExit,
    kill,
    release,
  };

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<{ terminalId: string }>}
   */
  async function create(message) {
    const params = paramsRecord(message.params);
    if (typeof params.command !== "string" || !params.command.trim()) {
      throw new Error("ACP terminal/create requires a command.");
    }
    const args = normalizeStringArray(params.args);
    const cwd = resolveRequestCwd(options.runConfig, typeof params.cwd === "string" ? params.cwd : null);
    const commandLine = formatCommandLine(params.command, args);
    await assertSandboxAccess({
      toolName: "Shell",
      input: { command: commandLine },
      runConfig: options.runConfig,
      cwd,
      hooks: options.hooks,
    });

    const terminalId = `terminal-${nextTerminalId}`;
    nextTerminalId += 1;
    const env = { ...process.env };
    for (const variable of normalizeEnvVariables(params.env)) {
      env[variable.name] = variable.value;
    }
    await options.emitRuntimeEvent({
      type: "command.started",
      provider: "acp",
      command: { command: commandLine, status: "started" },
      raw: { message },
    });
    const proc = spawn(params.command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {{ exitCode: number | null, signal: string | null } | null} */
    let exitStatus = null;
    /** @type {((value: { exitCode: number | null, signal: string | null }) => void) | null} */
    let resolveExit = null;
    /** @type {AcpTerminal} */
    const terminal = {
      proc,
      command: commandLine,
      output: "",
      outputByteLimit: typeof params.outputByteLimit === "number" ? params.outputByteLimit : null,
      exitStatus,
      exitPromise: new Promise((resolve) => {
        resolveExit = resolve;
      }),
    };
    /**
     * @param {{ exitCode: number | null, signal: string | null }} status
     * @returns {void}
     */
    function finish(status) {
      if (terminal.exitStatus) {
        return;
      }
      exitStatus = status;
      terminal.exitStatus = exitStatus;
      void options.emitRuntimeEvent({
        type: status.exitCode === 0 ? "command.completed" : "command.failed",
        provider: "acp",
        command: {
          command: commandLine,
          status: status.exitCode === 0 ? "completed" : "failed",
          ...(terminal.output ? { output: terminal.output } : {}),
        },
        raw: { message, exitStatus },
      });
      resolveExit?.(status);
    }
    proc.once("exit", (exitCode, signal) => {
      finish({ exitCode, signal });
    });
    proc.stdout.on("data", (chunk) => {
      terminal.output += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      terminal.output += String(chunk);
    });
    proc.once("error", (error) => {
      terminal.output += error instanceof Error ? error.message : String(error);
      finish({ exitCode: 1, signal: null });
    });
    terminals.set(terminalId, terminal);
    return { terminalId };
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {{ output: string, truncated: boolean, exitStatus?: { exitCode: number | null, signal: string | null } }}
   */
  function output(message) {
    const params = paramsRecord(message.params);
    const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
    const terminal = terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Unknown ACP terminal "${terminalId}".`);
    }
    const truncated = truncateTerminalOutput(terminal.output, terminal.outputByteLimit);
    return {
      ...truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<{ exitCode: number | null, signal: string | null }>}
   */
  async function waitForExit(message) {
    const params = paramsRecord(message.params);
    const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
    const terminal = terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Unknown ACP terminal "${terminalId}".`);
    }
    return terminal.exitStatus ?? await terminal.exitPromise;
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Record<string, never>}
   */
  function kill(message) {
    const params = paramsRecord(message.params);
    const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
    const terminal = terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Unknown ACP terminal "${terminalId}".`);
    }
    if (!terminal.exitStatus) {
      terminal.proc.kill();
    }
    return {};
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Record<string, never>}
   */
  function release(message) {
    const params = paramsRecord(message.params);
    const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
    const terminal = terminals.get(terminalId);
    if (!terminal) {
      return {};
    }
    if (!terminal.exitStatus) {
      terminal.proc.kill();
    }
    terminals.delete(terminalId);
    return {};
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
    { category: /** @type {"mode"} */ ("mode"), desired: input.runConfig?.mode ?? null },
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
      value,
    });
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
      value,
    });
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
      return [];
    }
    return normalizeConfigOptions(extractConfigOptions(opened));
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
  const { connection } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    const opened = await connection.sendRequest("session/new", buildSessionParams(input.runConfig));
    return normalizeConfigOptions(extractConfigOptions(opened));
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
      value: input.value,
    });
    return normalizeConfigOptions(extractConfigOptions(result));
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
  const event = /** @type {import("./harness-runtime-events.js").HarnessRuntimeEvent} */ ({
    type: "usage.updated",
    provider: "acp",
    usage: normalizeAcpUsage(promptResult.usage),
    raw: { promptResult },
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
  const connection = await openAcpConnection({
    command: input.command,
    args: input.args,
    cwd: input.runConfig?.workdir ?? undefined,
    env: input.env,
    signal: input.signal,
    handleRequest,
  });
  const initializeResult = await connection.sendRequest("initialize", {
    protocolVersion: 1,
    clientInfo: {
      name: "madabot",
      title: "Madabot",
      version: "1.0.0",
    },
    clientCapabilities: buildClientCapabilities(),
  });
  return {
    connection,
    capabilities: readAgentCapabilities(initializeResult),
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
 * @param {AcpForkInput & { includeTurns?: boolean }} input
 * @returns {Promise<unknown>}
 */
export async function readAcpSession(input) {
  const { connection, capabilities } = await openInitializedAcpConnection(input, async () => ({}));
  try {
    if (!hasAcpSessionCapability(capabilities, "read") && !hasMadabotAcpSessionCapability(capabilities, "read")) {
      return null;
    }
    return await connection.sendRequest("session/read", {
      sessionId: input.sessionId,
      ...(input.includeTurns ? { includeTurns: true } : {}),
    });
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
  const beforeSnapshot = await snapshotAcpWorkdir(input.runConfig?.workdir);
  /** @type {Set<string>} */
  const emittedFileChangePaths = new Set();
  /** @type {Set<string>} */
  const approvedProtectedPaths = new Set();
  const runtimeModel = createAcpRuntimeModel();
  const emitRuntimeEvent = async (/** @type {import("./harness-runtime-events.js").HarnessRuntimeEvent} */ event) => {
    const reconciled = reconcileAcpFileChangeWithBaseline(event, beforeSnapshot, input.runConfig?.workdir);
    if (reconciled.type === "file-change.completed") {
      const protectedMatch = matchProtectedPath(input.runConfig, reconciled.change.path);
      if (protectedMatch.protected && approvedProtectedPaths.has(protectedMatch.resolvedPath)) {
        emittedFileChangePaths.add(resolveAcpFileChangePath(input.runConfig?.workdir, reconciled.change.path));
        if (isAcpFileChangeIgnored(input.runConfig, reconciled.change.path)) {
          return;
        }
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
        /** @type {import("./harness-runtime-events.js").HarnessRuntimeEvent} */
        const failureEvent = {
          type: "tool.failed",
          provider: "acp",
          tool: {
            id: `protected-path:${protectedApproval.match.relativePath}`,
            name: "protected_path",
            arguments: { path: protectedApproval.match.relativePath },
            output: message,
          },
          raw: reconciled.raw,
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
      const events = runtimeModel.acceptSessionUpdate(message.params);
      for (const event of events) {
        await emitRuntimeEvent(event);
      }
    }
  })();

  try {
    if (sessionId) {
      if (hasAcpSessionCapability(capabilities, "resume")) {
        const resumed = await connection.sendRequest("session/resume", {
          sessionId,
          ...buildSessionParams(input.runConfig),
        });
        sessionId = readSessionId(resumed) ?? sessionId;
        configOptions = extractConfigOptions(resumed);
      } else if (supportsAcpLoadSession(capabilities)) {
        const loaded = await connection.sendRequest("session/load", {
          sessionId,
          ...buildSessionParams(input.runConfig),
        });
        sessionId = readSessionId(loaded) ?? sessionId;
        configOptions = extractConfigOptions(loaded);
      } else {
        throw new Error(`ACP agent does not advertise required session resume capability: ${JSON.stringify(buildCapabilityErrorDetails(capabilities))}`);
      }
    } else {
      const created = await connection.sendRequest("session/new", buildSessionParams(input.runConfig));
      sessionId = readSessionId(created);
      configOptions = extractConfigOptions(created);
    }
    await applySessionConfigOptions({ connection, sessionId, configOptions, runConfig: input.runConfig });
    unregisterActiveRun = input.onActiveRun?.({ connection, sessionId, capabilities });

    const promptResult = await connection.sendRequest("session/prompt", {
      ...(sessionId ? { sessionId } : {}),
      prompt: buildPromptContent(input.prompt),
    });
    sessionId = readSessionId(promptResult) ?? sessionId;
    await handlePromptUsage(input, runtimeDispatcher, promptResult);
    unregisterActiveRun?.();
    unregisterActiveRun = undefined;
    await connection.close();
    connectionClosed = true;
    await notificationsDone.catch(() => {});
    for (const event of runtimeModel.flushAssistantSegment()) {
      await emitRuntimeEvent(event);
    }
    const afterSnapshot = await snapshotAcpWorkdir(input.runConfig?.workdir);
    const snapshotFileChanges = collectAcpSnapshotFileChanges({
      before: beforeSnapshot,
      after: afterSnapshot,
      emittedPaths: emittedFileChangePaths,
    });
    await emitAcpSnapshotFileChangeEvents(snapshotFileChanges, emitRuntimeEvent);
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
