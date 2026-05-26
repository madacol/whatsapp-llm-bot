import { openAcpConnection } from "./acp-client.js";
import { normalizeAcpSessionUpdate, normalizeAcpUsage } from "./acp-events.js";
import { createHarnessRuntimeEventDispatcher } from "./harness-runtime-event-dispatcher.js";

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
    ...(runConfig?.workdir ? { cwd: runConfig.workdir } : {}),
    ...(runConfig?.model ? { model: runConfig.model } : {}),
  };
}

/**
 * @returns {Record<string, unknown>}
 */
function buildClientCapabilities() {
  return {
    fs: {
      readTextFile: false,
      writeTextFile: false,
    },
    terminal: false,
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
    },
  };
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<unknown>}
 */
async function handleAcpClientRequest(message) {
  if (message.method === "session/request_permission") {
    return { outcome: "approved" };
  }
  if (message.method === "terminal/create") {
    return { terminalId: `terminal-${Date.now()}` };
  }
  if (message.method === "terminal/output") {
    return {};
  }
  if (message.method === "terminal/release") {
    return {};
  }
  return {};
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
 * @returns {Promise<{ connection: Awaited<ReturnType<typeof openAcpConnection>>, capabilities: Record<string, unknown> }>}
 */
async function openInitializedAcpConnection(input) {
  const connection = await openAcpConnection({
    command: input.command,
    args: input.args,
    cwd: input.runConfig?.workdir ?? undefined,
    env: input.env,
    signal: input.signal,
    handleRequest: handleAcpClientRequest,
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
  const { connection, capabilities } = await openInitializedAcpConnection(input);
  try {
    if (!hasSessionCapability(capabilities, "fork")) {
      throw new Error(`ACP agent does not advertise required session fork capability: ${JSON.stringify(buildCapabilityErrorDetails(capabilities))}`);
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
 * @param {AcpRunInput} input
 * @returns {Promise<{ result: AgentResult, sessionId: string | null }>}
 */
export async function startAcpRun(input) {
  const runtimeDispatcher = createHarnessRuntimeEventDispatcher({
    provider: "acp",
    messages: input.messages ?? [],
    hooks: input.hooks,
    workdir: input.runConfig?.workdir ?? null,
  });
  const { connection, capabilities } = await openInitializedAcpConnection(input);
  let sessionId = input.sessionId ?? null;
  let promptCompleted = false;
  /** @type {void | (() => void)} */
  let unregisterActiveRun = undefined;

  const notificationsDone = (async () => {
    for await (const message of connection.notifications) {
      if (message.method !== "session/update" || !isRecord(message.params)) {
        continue;
      }
      const events = normalizeAcpSessionUpdate(message.params);
      for (const event of events) {
        input.emitEvent?.(event);
        await runtimeDispatcher.handleEvent(event);
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
      } else if (supportsLoadSession(capabilities)) {
        throw new Error("ACP agent supports session/load but not session/resume. Refusing to replay prior turns into chat output; enable the ACP session-resume RFD/capability in the adapter.");
      } else {
        throw new Error(`ACP agent does not advertise required session resume capability: ${JSON.stringify(buildCapabilityErrorDetails(capabilities))}`);
      }
    } else {
      const created = await connection.sendRequest("session/new", buildSessionParams(input.runConfig));
      sessionId = readSessionId(created);
    }
    unregisterActiveRun = input.onActiveRun?.({ connection, sessionId, capabilities });

    const promptResult = await connection.sendRequest("session/prompt", {
      ...(sessionId ? { sessionId } : {}),
      prompt: buildPromptContent(input.prompt),
    });
    sessionId = readSessionId(promptResult) ?? sessionId;
    await handlePromptUsage(input, runtimeDispatcher, promptResult);
    promptCompleted = true;
    return {
      result: runtimeDispatcher.result,
      sessionId,
    };
  } finally {
    unregisterActiveRun?.();
    await connection.close();
    await notificationsDone.catch(() => {});
    if (!promptCompleted && !runtimeDispatcher.result.response.length) {
      runtimeDispatcher.result.response = [];
    }
  }
}
