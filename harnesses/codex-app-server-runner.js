import { normalizeCodexAppServerEvent } from "./codex-app-server-events.js";
import { ReportedHarnessRunError, reportHarnessRunError } from "./harness-run-errors.js";
import { buildCodexTurnInput } from "./codex-runner.js";
import { openCodexAppServerConnection } from "./codex-app-server-client.js";
import { createCodexEventDispatcher } from "./codex-event-dispatcher.js";

/** @type {Pick<Required<AgentIOHooks>, "onComposing" | "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_CODEX_RUN_HOOKS = {
  onComposing: async () => {},
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
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {Record<string, unknown> | undefined}
 */
function buildSandboxPolicy(runConfig) {
  const mode = runConfig?.sandboxMode ?? null;
  const workdir = typeof runConfig?.workdir === "string" ? runConfig.workdir : null;
  switch (mode) {
    case "read-only":
      return { type: "readOnly" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
      return workdir
        ? {
          type: "workspaceWrite",
          writableRoots: [workdir, ...(runConfig?.additionalDirectories ?? [])],
          networkAccess: true,
        }
        : { type: "workspaceWrite", networkAccess: true };
    default:
      return undefined;
  }
}

/**
 * @param {HarnessRunConfig["approvalPolicy"] | undefined} approvalPolicy
 * @returns {string | undefined}
 */
function mapApprovalPolicy(approvalPolicy) {
  switch (approvalPolicy) {
    case "never":
      return "never";
    case "on-request":
      return "onRequest";
    case "untrusted":
      return "unlessTrusted";
    default:
      return undefined;
  }
}

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
 *   hooks?: Pick<AgentIOHooks, "onComposing" | "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
 *   isAborted?: () => boolean,
 * }} input
 * @returns {Promise<{
 *   abortController: AbortController,
 *   done: Promise<{ result: AgentResult, sessionId: string | null }>,
 *   steer: (text: string) => Promise<boolean>,
 *   interrupt: () => Promise<boolean>,
 * }>}
 */
export async function startCodexAppServerRun(input) {
  const hooks = { ...DEFAULT_CODEX_RUN_HOOKS, ...input.hooks };
  const abortController = new AbortController();
  const prompt = buildCodexTurnInput(input.prompt, input.externalInstructions);
  const sandboxPolicy = buildSandboxPolicy(input.runConfig);
  const approvalPolicy = mapApprovalPolicy(input.runConfig?.approvalPolicy);
  const dispatcher = createCodexEventDispatcher({
    hooks,
    runConfig: input.runConfig,
    messages: input.messages,
  });

  /** @type {string | null} */
  let threadId = input.sessionId ?? null;
  /** @type {string | null} */
  let turnId = null;
  let turnCompleted = false;

  const connection = await openCodexAppServerConnection({
    signal: abortController.signal,
    handleRequest: async (message) => handleServerRequest(message, hooks),
  });

  const threadRequestParams = {
    ...(input.runConfig?.model && { model: input.runConfig.model }),
    ...(input.runConfig?.workdir && { cwd: input.runConfig.workdir }),
    ...(approvalPolicy && { approvalPolicy }),
    serviceName: "whatsapp-llm-bot",
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

/**
 * @param {Record<string, unknown>} message
 * @param {Pick<Required<AgentIOHooks>, "onAskUser">} hooks
 * @returns {Promise<unknown>}
 */
async function handleServerRequest(message, hooks) {
  const method = typeof message.method === "string" ? message.method : null;
  const params = message.params && typeof message.params === "object"
    ? /** @type {Record<string, unknown>} */ (message.params)
    : {};
  if (!method) {
    return {};
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "this command";
    const choice = await hooks.onAskUser(`Allow *command execution*?`, ["✅ Allow", "❌ Deny"], undefined, [command]);
    return choice === "✅ Allow" ? "accept" : "decline";
  }

  if (method === "item/fileChange/requestApproval") {
    const choice = await hooks.onAskUser("Allow *file changes*?", ["✅ Allow", "❌ Deny"]);
    return choice === "✅ Allow" ? "accept" : "decline";
  }

  if (method === "tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    /** @type {Record<string, string>} */
    const answers = {};
    for (const question of questions) {
      if (!question || typeof question !== "object") {
        continue;
      }
      const record = /** @type {Record<string, unknown>} */ (question);
      const prompt = typeof record.question === "string" ? record.question : "Choose an option:";
      const options = Array.isArray(record.options)
        ? record.options
          .map((option) => option && typeof option === "object" && typeof /** @type {Record<string, unknown>} */ (option).label === "string"
            ? /** @type {Record<string, unknown>} */ (option).label
            : null)
          .filter((label) => typeof label === "string")
        : [];
      const answer = await hooks.onAskUser(prompt, options.length > 0 ? options : ["OK"]);
      answers[prompt] = answer || options[0] || "OK";
    }
    return { answers };
  }

  return {};
}
