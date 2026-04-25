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

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
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
    try {
      for await (const message of activeConnection.notifications) {
        const normalized = normalizeCodexAppServerEvent(message);
        if (!normalized) {
          continue;
        }

        if (normalized.sessionId) {
          threadId = normalized.sessionId;
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
      const { failureMessage } = dispatcher.finalize();
      if (failureMessage) {
        await hooks.onToolError(failureMessage);
        throw new ReportedHarnessRunError(failureMessage);
      }
      throw await reportHarnessRunError(error, hooks.onToolError);
    } finally {
      await activeConnection.close();
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
