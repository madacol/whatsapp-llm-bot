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

/** @type {Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_CODEX_RUN_HOOKS = {
  onComposing: async () => {},
  onPaused: async () => {},
  onReasoning: async () => {},
  onAskUser: async () => "",
  onToolCall: async () => {},
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
 *   hooks?: Pick<AgentIOHooks, "onComposing" | "onPaused" | "onReasoning" | "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
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

        if (normalized.sessionId) {
          threadId = normalized.sessionId;
        }

        if (isCurrentTurnStartedNotification(message)) {
          markTurnStarted();
        }

        if (typeof message.method === "string" && message.method === "turn/completed") {
          turnCompleted = true;
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
