import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { openAcpConnection } from "./acp-client.js";
import { normalizeAcpSessionUpdate, normalizeAcpUsage } from "./acp-events.js";
import { createHarnessRuntimeEventDispatcher } from "./harness-runtime-event-dispatcher.js";
import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import { requestSandboxEscapeApproval } from "./sandbox-approval-coordinator.js";

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

const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const SNAPSHOT_EXCLUDED_DIRS = new Set([".git", "node_modules", ".media", "coverage", "dist", "build"]);

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
 * @param {string} name
 * @returns {boolean}
 */
function hasSessionCapability(capabilities, name) {
  const sessionCapabilities = isRecord(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : null;
  const rfdSessionCapabilities = isRecord(capabilities.session) ? capabilities.session : null;
  return isRecord(sessionCapabilities?.[name]) || isRecord(rfdSessionCapabilities?.[name]);
}

/**
 * @param {Record<string, unknown>} capabilities
 * @param {string} name
 * @returns {boolean}
 */
function hasMadabotSessionCapability(capabilities, name) {
  const meta = isRecord(capabilities._meta) ? capabilities._meta : null;
  const madabot = isRecord(meta?.madabot) ? meta.madabot : null;
  const session = isRecord(madabot?.sessionCapabilities) ? madabot.sessionCapabilities : null;
  return session?.[name] === true || isRecord(session?.[name]);
}

/**
 * @param {Record<string, unknown>} capabilities
 * @returns {boolean}
 */
function supportsLoadSession(capabilities) {
  return capabilities.loadSession === true;
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
 * @param {Record<string, unknown>} capabilities
 * @returns {void}
 */
function assertRequiredAcpCapabilities(capabilities) {
  const missing = [];
  if (!hasSessionCapability(capabilities, "resume")) missing.push("session.resume");
  if (!hasSessionCapability(capabilities, "fork")) missing.push("session.fork");
  if (!hasSessionCapability(capabilities, "steer")) missing.push("session.steer");
  if (missing.length > 0) {
    throw new Error(`ACP agent is missing required Madabot capabilities: ${missing.join(", ")}. Details: ${JSON.stringify(buildCapabilityErrorDetails(capabilities))}`);
  }
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
 * }} options
 */
function createAcpClientRequestHandler(options) {
  const terminals = createAcpTerminalManager(options);
  return async (/** @type {Record<string, unknown>} */ message) => {
    if (message.method === "session/request_permission") {
      return handleAcpPermissionRequest(message, options.hooks);
    }
    if (message.method === "fs/read_text_file") {
      return handleAcpReadTextFile(message, options);
    }
    if (message.method === "fs/write_text_file") {
      return handleAcpWriteTextFile(message, options);
    }
    if (message.method === "terminal/create") {
      return terminals.create(message);
    }
    if (message.method === "terminal/output") {
      return terminals.output(message);
    }
    if (message.method === "terminal/wait_for_exit") {
      return terminals.waitForExit(message);
    }
    if (message.method === "terminal/kill") {
      return terminals.kill(message);
    }
    if (message.method === "terminal/release") {
      return terminals.release(message);
    }
    return {};
  };
}

/**
 * @param {Record<string, unknown>} message
 * @param {Pick<Required<AgentIOHooks>, "onAskUser">} hooks
 * @returns {Promise<{ outcome: { outcome: "selected", optionId: string } | { outcome: "cancelled" } }>}
 */
async function handleAcpPermissionRequest(message, hooks) {
  const params = paramsRecord(message.params);
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
  const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
  if (options.length === 0) {
    return { outcome: { outcome: "cancelled" } };
  }
  const labels = options.map((option) => typeof option.name === "string" ? option.name : String(option.optionId ?? "Option"));
  const descriptions = options.map((option) => typeof option.kind === "string" ? option.kind : "");
  const title = typeof toolCall.title === "string" && toolCall.title.trim()
    ? toolCall.title.trim()
    : "tool call";
  const choice = await hooks.onAskUser(`Allow *${title}*?`, labels, undefined, descriptions);
  const selected = options.find((option, index) => choice === labels[index] || choice === option.optionId)
    ?? options.find((option) => option.kind === "reject_once" || option.kind === "reject_always")
    ?? options[0];
  const optionId = typeof selected?.optionId === "string" ? selected.optionId : null;
  return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
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
  await options.emitRuntimeEvent({
    type: "file-change.completed",
    provider: "acp",
    change: {
      path: params.path,
      summary: "ACP file write",
      kind: oldText === undefined ? "add" : "update",
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
      toolName: "run_bash",
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
 * @param {"model" | "thought_level"} category
 * @returns {Record<string, unknown> | null}
 */
function findConfigOption(options, category) {
  const categoryMatch = options.find((option) => option.category === category);
  if (categoryMatch) {
    return categoryMatch;
  }
  const fallbackNames = category === "model" ? ["model"] : ["effort", "reasoning", "thought"];
  return options.find((option) => {
    const id = typeof option.id === "string" ? option.id.toLowerCase() : "";
    const name = typeof option.name === "string" ? option.name.toLowerCase() : "";
    return fallbackNames.some((candidate) => id.includes(candidate) || name.includes(candidate));
  }) ?? null;
}

/**
 * @param {Record<string, unknown>} option
 * @param {string} desired
 * @returns {string | null}
 */
function resolveConfigValue(option, desired) {
  const normalizedDesired = desired.trim().toLowerCase();
  const values = flattenSelectOptions(option);
  const match = values.find((value) => value.value.toLowerCase() === normalizedDesired)
    ?? values.find((value) => value.name.toLowerCase() === normalizedDesired);
  return match?.value ?? null;
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
  const targets = [
    { category: /** @type {"model"} */ ("model"), desired: input.runConfig?.model ?? null },
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
    if (!value || value === option.currentValue) {
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
 * @param {string | null | undefined} workdir
 * @returns {Promise<Map<string, string> | null>}
 */
async function snapshotWorkdir(workdir) {
  if (typeof workdir !== "string" || !workdir.trim()) {
    return null;
  }
  const root = path.resolve(workdir);
  /** @type {Map<string, string>} */
  const snapshot = new Map();
  await collectSnapshotFiles(root, snapshot);
  return snapshot;
}

/**
 * @param {string} currentPath
 * @param {Map<string, string>} snapshot
 * @returns {Promise<void>}
 */
async function collectSnapshotFiles(currentPath, snapshot) {
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) {
        await collectSnapshotFiles(path.join(currentPath, entry.name), snapshot);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(currentPath, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      if (!content.includes("\0")) {
        snapshot.set(filePath, content);
      }
    } catch {
      // Snapshotting is a best-effort display fallback.
    }
  }
}

/**
 * @param {{
 *   before: Map<string, string> | null,
 *   after: Map<string, string> | null,
 *   emittedPaths: Set<string>,
 *   emitRuntimeEvent: (event: import("./harness-runtime-events.js").HarnessRuntimeEvent) => Promise<void>,
 * }} input
 * @returns {Promise<void>}
 */
async function emitSnapshotFileChanges(input) {
  if (!input.before || !input.after) {
    return;
  }
  for (const [filePath, newText] of input.after) {
    if (input.emittedPaths.has(filePath)) {
      continue;
    }
    const oldText = input.before.get(filePath);
    if (oldText === newText) {
      continue;
    }
    await input.emitRuntimeEvent({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: "ACP file change",
        kind: oldText === undefined ? "add" : "update",
        ...(oldText !== undefined ? { oldText } : {}),
        newText,
      },
      raw: { source: "workdir-snapshot" },
    });
  }
  for (const [filePath, oldText] of input.before) {
    if (input.emittedPaths.has(filePath) || input.after.has(filePath)) {
      continue;
    }
    await input.emitRuntimeEvent({
      type: "file-change.completed",
      provider: "acp",
      change: {
        path: filePath,
        summary: "ACP file delete",
        kind: "delete",
        oldText,
      },
      raw: { source: "workdir-snapshot" },
    });
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
  assertRequiredAcpCapabilities(capabilities);
  try {
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
    if (!hasSessionCapability(capabilities, "read") && !hasMadabotSessionCapability(capabilities, "read")) {
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
    if (!hasSessionCapability(capabilities, "rollback") && !hasMadabotSessionCapability(capabilities, "rollback")) {
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
 * @returns {Promise<{ result: AgentResult, sessionId: string | null }>}
 */
export async function startAcpRun(input) {
  const hooks = { ...DEFAULT_ACP_HOOKS, ...input.hooks };
  const runtimeDispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: input.messages ?? [],
    hooks,
    workdir: input.runConfig?.workdir ?? null,
  });
  /** @type {Set<string>} */
  const emittedFileChangePaths = new Set();
  const emitRuntimeEvent = async (/** @type {import("./harness-runtime-events.js").HarnessRuntimeEvent} */ event) => {
    if (event.type === "file-change.completed") {
      emittedFileChangePaths.add(path.resolve(input.runConfig?.workdir ?? process.cwd(), event.change.path));
    }
    input.emitEvent?.(event);
    await runtimeDispatcher.handleEvent(event);
  };
  const handleRequest = createAcpClientRequestHandler({
    hooks,
    runConfig: input.runConfig,
    emitRuntimeEvent,
  });
  const beforeSnapshot = await snapshotWorkdir(input.runConfig?.workdir);
  const { connection, capabilities } = await openInitializedAcpConnection(input, handleRequest);
  assertRequiredAcpCapabilities(capabilities);
  let sessionId = input.sessionId ?? null;
  let promptCompleted = false;
  let connectionClosed = false;
  /** @type {Record<string, unknown>[]} */
  let configOptions = [];
  /** @type {void | (() => void)} */
  let unregisterActiveRun = undefined;

  const notificationsDone = (async () => {
    for await (const message of connection.notifications) {
      if (message.method !== "session/update" || !isRecord(message.params)) {
        continue;
      }
      const events = normalizeAcpSessionUpdate(message.params);
      for (const event of events) {
        await emitRuntimeEvent(event);
      }
    }
  })();

  try {
    if (sessionId) {
      if (hasSessionCapability(capabilities, "resume")) {
        const resumed = await connection.sendRequest("session/resume", {
          sessionId,
          ...buildSessionParams(input.runConfig),
        });
        sessionId = readSessionId(resumed) ?? sessionId;
        configOptions = extractConfigOptions(resumed);
      } else if (supportsLoadSession(capabilities)) {
        throw new Error("ACP agent supports session/load but not session/resume. Refusing to replay prior turns into chat output; enable the ACP session-resume RFD/capability in the adapter.");
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
    const afterSnapshot = await snapshotWorkdir(input.runConfig?.workdir);
    await emitSnapshotFileChanges({
      before: beforeSnapshot,
      after: afterSnapshot,
      emittedPaths: emittedFileChangePaths,
      emitRuntimeEvent,
    });
    promptCompleted = true;
    return {
      result: runtimeDispatcher.result,
      sessionId,
    };
  } finally {
    unregisterActiveRun?.();
    if (!connectionClosed) {
      await connection.close();
      await notificationsDone.catch(() => {});
    }
    if (!promptCompleted && !runtimeDispatcher.result.response.length) {
      runtimeDispatcher.result.response = [];
    }
  }
}
