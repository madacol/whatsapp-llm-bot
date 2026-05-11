import { normalizeCodexAppServerEvent } from "./codex-app-server-events.js";
import { ReportedHarnessRunError, isTransientHarnessRunError, reportHarnessRunError } from "./harness-run-errors.js";
import { buildCodexTurnInput } from "./codex-runner.js";
import { openCodexAppServerConnection } from "./codex-app-server-client.js";
import { createCodexEventDispatcher } from "./codex-event-dispatcher.js";
import { createCodexFileChangeTracker } from "./codex-file-change-tracker.js";
import {
  buildCodexAppServerSandboxPolicy,
  handleCodexAppServerRequest,
  mapCodexAppServerApprovalPolicy,
} from "./codex-app-server-protocol.js";

/** @type {Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onAskUser" | "onToolCall" | "onToolComplete" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_CODEX_RUN_HOOKS = {
  onComposing: async () => {},
  onPaused: async () => {},
  onReasoning: async () => {},
  onAskUser: async () => "",
  onToolCall: async () => {},
  onToolComplete: async () => {},
  onCommand: async () => {},
  onFileRead: async () => {},
  onPlan: async () => {},
  onFileChange: async () => {},
  onLlmResponse: async () => {},
  onToolError: async () => {},
  onUsage: async () => {},
};

const MAX_STARTUP_RETRIES = 1;
const TURN_STEER_READY_TIMEOUT_MS = 5_000;
const INCOMPLETE_TURN_DISCONNECT_MESSAGE = "Codex disconnected while the turn was still in progress. Send a follow-up after a moment to resume the saved thread.";

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @typedef {{
 *   id: string,
 *   status: string,
 *   items: Array<Record<string, unknown>>,
 * }} PersistedCodexTurn
 */

/**
 * @param {unknown} value
 * @returns {value is PersistedCodexTurn}
 */
function isPersistedCodexTurn(value) {
  return isObjectRecord(value)
    && typeof value.id === "string"
    && typeof value.status === "string"
    && Array.isArray(value.items)
    && value.items.every(isObjectRecord);
}

/**
 * @param {unknown} source
 * @returns {Record<string, unknown> | null}
 */
function extractSubagentSource(source) {
  if (!isObjectRecord(source)) {
    return null;
  }
  const subagent = source.subagent ?? source.subAgent;
  return isObjectRecord(subagent) ? subagent : null;
}

/**
 * @param {unknown} response
 * @param {string} fallbackThreadId
 * @returns {import("./codex-events.js").CodexThreadEvent | null}
 */
function extractReadThreadSubagentEvent(response, fallbackThreadId) {
  if (!isObjectRecord(response) || !isObjectRecord(response.thread)) {
    return null;
  }
  const thread = response.thread;
  const id = typeof thread.id === "string" ? thread.id : fallbackThreadId;
  const subagent = extractSubagentSource(thread.source);
  const threadSpawn = isObjectRecord(subagent?.thread_spawn) ? subagent.thread_spawn : null;
  const agentNickname = typeof thread.agentNickname === "string"
    ? thread.agentNickname
    : typeof threadSpawn?.agent_nickname === "string" ? threadSpawn.agent_nickname : undefined;
  const agentRole = typeof thread.agentRole === "string"
    ? thread.agentRole
    : typeof threadSpawn?.agent_role === "string" ? threadSpawn.agent_role : undefined;
  const parentThreadId = typeof threadSpawn?.parent_thread_id === "string" ? threadSpawn.parent_thread_id : undefined;

  if (!agentNickname && !agentRole && !parentThreadId) {
    return null;
  }

  return {
    id,
    kind: "subagent",
    ...(parentThreadId !== undefined && { parentThreadId }),
    ...(agentNickname !== undefined && { agentNickname }),
    ...(agentRole !== undefined && { agentRole }),
  };
}

/**
 * @param {import("./codex-events.js").CodexToolEvent | undefined} toolEvent
 * @returns {string[]}
 */
function extractSpawnedReceiverThreadIds(toolEvent) {
  if (!toolEvent || toolEvent.name !== "spawn_agent" || toolEvent.status !== "completed") {
    return [];
  }
  const receiverThreadIds = toolEvent.arguments.receiver_thread_ids;
  return Array.isArray(receiverThreadIds)
    ? receiverThreadIds.filter((threadId) => typeof threadId === "string")
    : [];
}

/**
 * @param {unknown} response
 * @returns {PersistedCodexTurn[]}
 */
function extractPersistedTurns(response) {
  if (!isObjectRecord(response) || !isObjectRecord(response.thread) || !Array.isArray(response.thread.turns)) {
    return [];
  }
  return response.thread.turns.filter(isPersistedCodexTurn);
}

/**
 * @param {PersistedCodexTurn} turn
 * @returns {string | null}
 */
function extractFinalAgentMessage(turn) {
  /** @type {string | null} */
  let latestAgentText = null;
  /** @type {string | null} */
  let latestFinalText = null;
  for (const item of turn.items) {
    if (item.type !== "agentMessage" || typeof item.text !== "string" || item.text.trim().length === 0) {
      continue;
    }
    latestAgentText = item.text;
    if (item.phase === "final_answer") {
      latestFinalText = item.text;
    }
  }
  return latestFinalText ?? latestAgentText;
}

/**
 * The chat session must remain pinned to the parent thread that started the
 * turn. Sub-agent notifications carry their own thread ids and must not become
 * the resumable chat session.
 * @param {string | null} currentThreadId
 * @param {import("./codex-events.js").NormalizedCodexEvent} normalized
 * @returns {string | null}
 */
function resolveSessionThreadId(currentThreadId, normalized) {
  const nextThreadId = normalized.sessionId;
  if (!nextThreadId) {
    return currentThreadId;
  }
  if (normalized.threadEvent?.kind === "subagent") {
    return currentThreadId;
  }
  if (currentThreadId && nextThreadId !== currentThreadId) {
    return currentThreadId;
  }
  return nextThreadId;
}

/**
 * @param {{
 *   openConnection: typeof openCodexAppServerConnection,
 *   env?: NodeJS.ProcessEnv,
 *   abortController: AbortController,
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser" | "onFileChange" | "onLlmResponse">,
 *   fileChangeTracker: ReturnType<typeof createCodexFileChangeTracker>,
 *   runConfig?: HarnessRunConfig,
 *   threadId: string,
 *   turnId: string,
 *   messages: Message[],
 *   usage: AgentResult["usage"],
 * }} input
 * @returns {Promise<{ result: AgentResult, sessionId: string } | null>}
 */
async function recoverCompletedTurn(input) {
  const connection = await input.openConnection({
    ...(input.env ? { env: input.env } : {}),
    signal: input.abortController.signal,
    handleRequest: async (message) => handleCodexAppServerRequest(message, input.hooks, {
      fileChangeTracker: input.fileChangeTracker,
      runConfig: input.runConfig,
    }),
  });
  try {
    const response = await connection.sendRequest("thread/read", {
      threadId: input.threadId,
      includeTurns: true,
    });
    const turn = extractPersistedTurns(response).find((candidate) => candidate.id === input.turnId) ?? null;
    if (turn?.status !== "completed") {
      return null;
    }
    const text = extractFinalAgentMessage(turn);
    if (!text) {
      return null;
    }
    await input.hooks.onLlmResponse(text);
    return {
      sessionId: input.threadId,
      result: {
        response: [{ type: "markdown", text }],
        messages: input.messages,
        usage: input.usage,
      },
    };
  } finally {
    await connection.close();
  }
}

/**
 * @param {{
 *   chatId: string,
 *   prompt: string,
 *   externalInstructions?: string,
 *   messages: Message[],
 *   sessionId?: string | null,
 *   runConfig?: HarnessRunConfig,
 *   env?: NodeJS.ProcessEnv,
 *   hooks?: Pick<AgentIOHooks, "onComposing" | "onPaused" | "onReasoning" | "onAskUser" | "onToolCall" | "onToolComplete" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
 *   isAborted?: () => boolean,
 * }} input
 * @param {{
 *   openConnection?: typeof openCodexAppServerConnection,
 * }} [deps]
 * @returns {Promise<{
 *   abortController: AbortController,
 *   done: Promise<{ result: AgentResult, sessionId: string | null }>,
 *   steer: (text: string) => Promise<boolean>,
 *   interrupt: () => Promise<boolean>,
 * }>}
 */
export async function startCodexAppServerRun(input, deps = {}) {
  const openConnection = deps.openConnection ?? openCodexAppServerConnection;
  const hooks = { ...DEFAULT_CODEX_RUN_HOOKS, ...input.hooks };
  const abortController = new AbortController();
  const prompt = buildCodexTurnInput(input.prompt, input.externalInstructions);
  const sandboxPolicy = buildCodexAppServerSandboxPolicy(input.runConfig);
  const approvalPolicy = mapCodexAppServerApprovalPolicy(input.runConfig?.approvalPolicy);
  const fileChangeTracker = createCodexFileChangeTracker();
  const dispatcher = createCodexEventDispatcher({
    hooks,
    runConfig: input.runConfig,
    messages: input.messages,
    fileChangeTracker,
  });

  /** @type {string | null} */
  let threadId = input.sessionId ?? null;
  /** @type {string | null} */
  let turnId = null;
  let turnCompleted = false;
  let turnStarted = false;
  /** @type {Map<string, import("./codex-events.js").CodexThreadEvent | null>} */
  const readSubagentThreadEvents = new Map();
  /** @type {Set<string>} */
  const dispatchedSubagentThreadEvents = new Set();
  /** @type {Set<string>} */
  const spawnedReceiverThreadIds = new Set();
  /** @type {() => void} */
  let resolveTurnStarted = () => {};
  /** @type {Promise<void>} */
  const turnStartedPromise = new Promise((resolve) => {
    resolveTurnStarted = () => resolve();
  });

  /**
   * @returns {void}
   */
  function markTurnStarted() {
    if (turnStarted) {
      return;
    }
    turnStarted = true;
    resolveTurnStarted();
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {boolean}
   */
  function isCurrentTurnStartedNotification(message) {
    if (message.method !== "turn/started" || !turnId || !isObjectRecord(message.params)) {
      return false;
    }
    const turn = message.params.turn;
    return isObjectRecord(turn) && turn.id === turnId;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function waitForTurnStarted() {
    if (turnStarted) {
      return true;
    }
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timeout = null;
    try {
      return await Promise.race([
        turnStartedPromise.then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), TURN_STEER_READY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * @param {string} subagentThreadId
   * @returns {Promise<import("./codex-events.js").CodexThreadEvent | null>}
   */
  async function readSubagentThreadEvent(subagentThreadId) {
    if (readSubagentThreadEvents.has(subagentThreadId)) {
      return readSubagentThreadEvents.get(subagentThreadId) ?? null;
    }
    try {
      const response = await activeConnection.sendRequest("thread/read", { threadId: subagentThreadId });
      const threadEvent = extractReadThreadSubagentEvent(response, subagentThreadId);
      readSubagentThreadEvents.set(subagentThreadId, threadEvent);
      return threadEvent;
    } catch {
      readSubagentThreadEvents.set(subagentThreadId, null);
      return null;
    }
  }

  /**
   * @param {string} subagentThreadId
   * @returns {Promise<void>}
   */
  async function dispatchReadSubagentThreadEvent(subagentThreadId) {
    const threadEvent = await readSubagentThreadEvent(subagentThreadId);
    if (!threadEvent || dispatchedSubagentThreadEvents.has(threadEvent.id)) {
      return;
    }
    dispatchedSubagentThreadEvents.add(threadEvent.id);
    await dispatcher.handleNormalized({
      sessionId: threadEvent.id,
      threadEvent,
    });
  }

  const threadRequestParams = {
    ...(input.runConfig?.model && { model: input.runConfig.model }),
    ...(input.runConfig?.workdir && { cwd: input.runConfig.workdir }),
    ...(approvalPolicy && { approvalPolicy }),
    serviceName: "madabot",
  };

  /** @type {Awaited<ReturnType<typeof openConnection>> | null} */
  let connection = null;
  for (let attemptIndex = 0; attemptIndex <= MAX_STARTUP_RETRIES; attemptIndex += 1) {
    let turnStartRequested = false;
    try {
      connection = await openConnection({
        ...(input.env ? { env: input.env } : {}),
        signal: abortController.signal,
        handleRequest: async (message) => handleCodexAppServerRequest(message, hooks, {
          fileChangeTracker,
          runConfig: input.runConfig,
        }),
      });

      const threadResult = /** @type {{ thread?: { id?: string } }} */ (
        await connection.sendRequest(input.sessionId ? "thread/resume" : "thread/start", input.sessionId
          ? { threadId: input.sessionId, ...threadRequestParams }
          : threadRequestParams)
      );
      if (threadResult.thread?.id) {
        threadId = threadResult.thread.id;
      }

      turnStartRequested = true;
      const turnResult = /** @type {{ turn?: { id?: string } }} */ (
        await connection.sendRequest("turn/start", {
          ...(threadId && { threadId }),
          input: [{ type: "text", text: prompt }],
          ...(input.runConfig?.workdir && { cwd: input.runConfig.workdir }),
          ...(approvalPolicy && { approvalPolicy }),
          ...(sandboxPolicy && { sandboxPolicy }),
          ...(input.runConfig?.model && { model: input.runConfig.model }),
        })
      );
      turnId = typeof turnResult.turn?.id === "string" ? turnResult.turn.id : null;
      break;
    } catch (error) {
      await connection?.close();
      connection = null;
      const canRetry = !turnStartRequested
        && attemptIndex < MAX_STARTUP_RETRIES
        && !abortController.signal.aborted
        && isTransientHarnessRunError(error);
      if (canRetry) {
        continue;
      }
      throw error;
    }
  }

  if (!connection) {
    throw new Error("Codex app-server connection was not established.");
  }
  const activeConnection = connection;

  const done = (async () => {
    /** @type {unknown} */
    let streamError = null;
    try {
      for await (const message of activeConnection.notifications) {
        const normalized = normalizeCodexAppServerEvent(message);
        if (!normalized) {
          continue;
        }

        threadId = resolveSessionThreadId(threadId, normalized);

        if (isCurrentTurnStartedNotification(message)) {
          markTurnStarted();
        }

        if (typeof message.method === "string" && message.method === "turn/completed") {
          turnCompleted = true;
        }
        if (normalized.threadEvent?.kind === "subagent") {
          readSubagentThreadEvents.set(normalized.threadEvent.id, normalized.threadEvent);
          dispatchedSubagentThreadEvents.add(normalized.threadEvent.id);
        }
        for (const threadId of extractSpawnedReceiverThreadIds(normalized.toolEvent)) {
          spawnedReceiverThreadIds.add(threadId);
        }
        if (normalized.sessionId && spawnedReceiverThreadIds.has(normalized.sessionId)) {
          await dispatchReadSubagentThreadEvent(normalized.sessionId);
        }
        for (const response of normalized.subagentResponses ?? []) {
          if (!response.threadId) {
            continue;
          }
          await dispatchReadSubagentThreadEvent(response.threadId);
        }
        await dispatcher.handleNormalized(normalized);

        if (turnCompleted) {
          break;
        }
      }
    } catch (error) {
      if (input.isAborted?.() || isAbortError(error)) {
        return { result: dispatcher.result, sessionId: threadId };
      }
      streamError = error;
    } finally {
      await activeConnection.close();
    }

    if (!turnCompleted && threadId && turnId && (!streamError || isTransientHarnessRunError(streamError))) {
      const recovered = await recoverCompletedTurn({
        openConnection,
        ...(input.env ? { env: input.env } : {}),
        abortController,
        hooks,
        fileChangeTracker,
        runConfig: input.runConfig,
        threadId,
        turnId,
        messages: input.messages,
        usage: dispatcher.result.usage,
      });
      if (recovered) {
        return recovered;
      }
      if (!streamError) {
        await hooks.onToolError(INCOMPLETE_TURN_DISCONNECT_MESSAGE);
        throw new ReportedHarnessRunError(INCOMPLETE_TURN_DISCONNECT_MESSAGE);
      }
    }

    if (streamError) {
      const { failureMessage } = dispatcher.finalize();
      if (failureMessage) {
        await hooks.onToolError(failureMessage);
        throw new ReportedHarnessRunError(failureMessage);
      }
      throw await reportHarnessRunError(streamError, hooks.onToolError);
    }

    const { result, failureMessage } = dispatcher.finalize();

    if (failureMessage) {
      await hooks.onToolError(failureMessage);
      throw new ReportedHarnessRunError(failureMessage);
    }

    if (result.usage.promptTokens > 0 || result.usage.completionTokens > 0 || result.usage.cachedTokens > 0) {
      await hooks.onUsage(result.usage.cost > 0 ? result.usage.cost.toFixed(6) : "0.000000", {
        prompt: result.usage.promptTokens,
        completion: result.usage.completionTokens,
        cached: result.usage.cachedTokens,
        ...(result.usage.totalTokens !== undefined && { total: result.usage.totalTokens }),
        ...(result.usage.reasoningTokens !== undefined && { reasoning: result.usage.reasoningTokens }),
        ...(result.usage.contextWindow !== undefined && { contextWindow: result.usage.contextWindow }),
      });
    }

    return { result, sessionId: threadId };
  })();

  return {
    abortController,
    done,
    steer: async (text) => {
      if (!threadId || !turnId || turnCompleted || !text) {
        return false;
      }
      const canSteer = await waitForTurnStarted();
      if (!canSteer || turnCompleted) {
        return false;
      }
      await activeConnection.sendRequest("turn/steer", {
        threadId,
        input: [{ type: "text", text }],
        expectedTurnId: turnId,
      });
      return true;
    },
    interrupt: async () => {
      if (!threadId || !turnId || turnCompleted) {
        return false;
      }
      await activeConnection.sendRequest("turn/interrupt", {
        threadId,
        turnId,
      });
      return true;
    },
  };
}
