import path from "node:path";
import { spawn } from "node:child_process";
import { createAcpRawPayload } from "./acp-events.js";
import { createAcpExtensionRouter } from "./acp-extension-router.js";
import { createAcpFilesystemCapability } from "./acp-filesystem-capability.js";
import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import { requestSandboxEscapeApproval } from "./sandbox-approval-coordinator.js";
import { getProtectedPathPatterns, matchProtectedPath, requestProtectedPathApproval } from "./protected-paths.js";

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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function paramsRecord(value) {
  return isRecord(value) ? value : {};
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {boolean}
 */
function hasProtectedPathPolicy(runConfig) {
  return getProtectedPathPatterns(runConfig).length > 0;
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
 * @param {Record<string, unknown>[]} requestOptions
 * @param {string[]} kinds
 * @returns {Record<string, unknown> | null}
 */
function findPermissionOptionByKind(requestOptions, kinds) {
  return requestOptions.find((option) => typeof option.kind === "string" && kinds.includes(option.kind)) ?? null;
}

/**
 * @param {Record<string, unknown>} option
 * @returns {string | null}
 */
function permissionOptionId(option) {
  return typeof option.optionId === "string" ? option.optionId : null;
}

/**
 * @param {{
 *   params: Record<string, unknown>,
 *   requestOptions: Record<string, unknown>[],
 *   runConfig?: HarnessRunConfig,
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   approvedProtectedPaths?: Set<string>,
 *   pendingEditDiffPaths?: Map<string, string[]>,
 * }} input
 * @returns {Promise<string | null>}
 */
async function resolveProtectedEditPermissionOptionId(input) {
  if (!hasProtectedPathPolicy(input.runConfig)) {
    return null;
  }
  const toolCall = isRecord(input.params.toolCall) ? input.params.toolCall : {};
  if (toolCall.kind !== "edit") {
    return null;
  }
  const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : null;
  const paths = extractDiffContentPaths(toolCall.content);
  const pendingPaths = toolCallId ? input.pendingEditDiffPaths?.get(toolCallId) ?? [] : [];
  const candidatePaths = paths.length > 0 ? paths : pendingPaths;
  if (candidatePaths.length === 0) {
    return null;
  }
  const protectedPaths = candidatePaths
    .map((filePath) => matchProtectedPath(input.runConfig, filePath))
    .filter((match) => match.protected);
  const allowOptionId = permissionOptionId(findPermissionOptionByKind(input.requestOptions, ["allow_once", "allow_always"]) ?? input.requestOptions[0] ?? {});
  const rejectOptionId = permissionOptionId(findPermissionOptionByKind(input.requestOptions, ["reject_once", "reject_always"]) ?? input.requestOptions.at(-1) ?? {});
  if (protectedPaths.length === 0) {
    return allowOptionId;
  }
  for (const protectedPath of protectedPaths) {
    const approval = await requestProtectedPathApproval({
      runConfig: input.runConfig,
      filePath: protectedPath.resolvedPath,
      action: "ACP edit approval",
      hooks: input.hooks,
    });
    if (!approval.allowed) {
      return rejectOptionId;
    }
    input.approvedProtectedPaths?.add(approval.match.resolvedPath);
  }
  return allowOptionId;
}

/**
 * @param {unknown} decision
 * @returns {string | null}
 */
function normalizePermissionDecision(decision) {
  if (typeof decision === "string") {
    return decision;
  }
  if (isRecord(decision) && typeof decision.optionId === "string") {
    return decision.optionId;
  }
  return null;
}

/**
 * @param {Promise<unknown> | undefined} decision
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
async function waitForExternalPermissionDecision(decision, timeoutMs) {
  if (!decision) {
    return null;
  }
  return await Promise.race([
    decision.then(normalizePermissionDecision),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * @param {Record<string, unknown>} message
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>,
 *   requestDecision?: (request: { id: string, title: string, labels: string[], descriptions: string[] }) => Promise<unknown>,
 *   approvedProtectedPaths?: Set<string>,
 *   pendingEditDiffPaths?: Map<string, string[]>,
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
  const externalDecision = options.requestDecision?.({ id, title, labels, descriptions });
  await options.emitRuntimeEvent({
    type: "request.opened",
    provider: "acp",
    request: {
      id,
      kind: "tool-user-input",
      summary: title,
      detail: labels.join(", "),
    },
    diagnosticRaw: createAcpRawPayload("session/request_permission", message.params),
  });
  const protectedEditOptionId = await resolveProtectedEditPermissionOptionId({
    params,
    requestOptions,
    runConfig: options.runConfig,
    hooks: options.hooks,
    approvedProtectedPaths: options.approvedProtectedPaths,
    pendingEditDiffPaths: options.pendingEditDiffPaths,
  });
  if (protectedEditOptionId) {
    await options.emitRuntimeEvent({
      type: "request.resolved",
      provider: "acp",
      request: {
        id,
        kind: "tool-user-input",
        summary: `selected:${protectedEditOptionId}`,
      },
      diagnosticRaw: createAcpRawPayload("session/request_permission", { optionId: protectedEditOptionId }),
    });
    return { outcome: { outcome: "selected", optionId: protectedEditOptionId } };
  }
  const selectedChoice = await waitForExternalPermissionDecision(externalDecision, 100)
    ?? normalizePermissionDecision(await options.hooks.onAskUser(`Allow *${title}*?`, labels, undefined, descriptions));
  const selected = requestOptions.find((option, index) => selectedChoice === labels[index] || selectedChoice === option.optionId)
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
    diagnosticRaw: createAcpRawPayload("session/request_permission", { optionId }),
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
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>,
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
  const rawExternalDecision = options.userInputDecision?.(runtimeRequest);
  await options.emitRuntimeEvent({
    type: "user-input.requested",
    provider: "acp",
    request: runtimeRequest,
    diagnosticRaw: createAcpRawPayload("elicitation/create", message.params),
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
  const externalDecision = rawExternalDecision
    ?.then((response) => normalizeExternalElicitationResponse(response, questions))
    .then((response) => response ?? hookDecision);
  const decision = await (externalDecision
    ? Promise.race([externalDecision, hookDecision])
    : hookDecision);
  await options.emitRuntimeEvent({
    type: "user-input.resolved",
    provider: "acp",
    request: runtimeRequest,
    diagnosticRaw: createAcpRawPayload("elicitation/create", decision),
  });
  return decision;
}

/**
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>,
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
      diagnosticRaw: { message },
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
        diagnosticRaw: { message, exitStatus },
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
 * @param {{
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   runConfig?: HarnessRunConfig,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEventInput) => Promise<void>,
 *   requestDecision?: (request: { id: string, title: string, labels: string[], descriptions: string[] }) => Promise<string | null>,
 *   userInputDecision?: (request: import("./harness-runtime-events.js").HarnessRuntimeUserInputRequest) => Promise<unknown>,
 *   approvedProtectedPaths?: Set<string>,
 *   pendingEditDiffPaths?: Map<string, string[]>,
 * }} options
 */
export function createAcpClientRequestHandler(options) {
  const terminals = createAcpTerminalManager(options);
  const filesystem = createAcpFilesystemCapability({
    hooks: options.hooks,
    runConfig: options.runConfig,
    emitRuntimeEvent: options.emitRuntimeEvent,
    approvedProtectedPaths: options.approvedProtectedPaths,
  });
  /** @type {Map<string, (message: Record<string, unknown>) => Promise<unknown> | unknown>} */
  const requestHandlers = new Map();
  requestHandlers.set("session/request_permission", (message) => handleAcpPermissionRequest(message, options));
  requestHandlers.set("elicitation/create", (message) => handleAcpElicitationCreate(message, options));
  requestHandlers.set("fs/read_text_file", (message) => filesystem.readTextFile(message));
  requestHandlers.set("fs/write_text_file", (message) => filesystem.writeTextFile(message));
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
