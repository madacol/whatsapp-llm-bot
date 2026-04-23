import { normalizeCodexAppServerEvent } from "./codex-app-server-events.js";
import { ReportedHarnessRunError, reportHarnessRunError } from "./harness-run-errors.js";
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
 *   codexArgs?: string[],
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

  const connection = await openConnection({
    ...(input.codexArgs?.length ? { args: input.codexArgs } : {}),
    ...(input.env ? { env: input.env } : {}),
    signal: abortController.signal,
    handleRequest: async (message) => handleCodexAppServerRequest(message, hooks, {
      fileChangeTracker,
      runConfig: input.runConfig,
    }),
  });

  const threadRequestParams = {
    ...(input.runConfig?.model && { model: input.runConfig.model }),
    ...(input.runConfig?.workdir && { cwd: input.runConfig.workdir }),
    ...(approvalPolicy && { approvalPolicy }),
    serviceName: "madabot",
  };

  try {
    const threadResult = /** @type {{ thread?: { id?: string } }} */ (
      await connection.sendRequest(input.sessionId ? "thread/resume" : "thread/start", input.sessionId
        ? { threadId: input.sessionId, ...threadRequestParams }
        : threadRequestParams)
    );
    if (threadResult.thread?.id) {
      threadId = threadResult.thread.id;
    }
  } catch (error) {
    await connection.close();
    throw error;
  }

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

  const done = (async () => {
    try {
      for await (const message of connection.notifications) {
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
      await connection.close();
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
      await connection.sendRequest("turn/steer", {
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
      await connection.sendRequest("turn/interrupt", {
        threadId,
        turnId,
      });
      return true;
    },
  };
}
