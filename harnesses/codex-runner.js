import { Codex } from "@openai/codex-sdk";
import { createLogger } from "../logger.js";
import { normalizeCodexEvent } from "./codex-sdk-events.js";
import { analyzeCodexCommand } from "./codex-command-semantics.js";
import { ReportedHarnessRunError, reportHarnessRunError, isReportedHarnessRunError } from "./harness-run-errors.js";
import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import {
  appendSandboxWritableRoot,
  requestSandboxEscapeApproval,
  resolveSandboxApprovalDirectory,
} from "./sandbox-approval-coordinator.js";
import { createCodexEventDispatcher } from "./codex-event-dispatcher.js";

const log = createLogger("harness:codex-runner");

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
 * @returns {error is ReportedHarnessRunError}
 */
export function isHandledCodexRunError(error) {
  return isReportedHarnessRunError(error);
}

/**
 * @typedef {{
 *   runStreamed: (
 *     input: string | Array<{ type: "text", text: string } | { type: "local_image", path: string }>,
 *     turnOptions?: { signal?: AbortSignal, outputSchema?: unknown }
 *   ) => Promise<{ events: AsyncGenerator<unknown> }>,
 *   id: string | null,
 * }} CodexThreadLike
 */

/**
 * @typedef {{
 *   startThread: (options?: import("@openai/codex-sdk").ThreadOptions) => CodexThreadLike,
 *   resumeThread: (id: string, options?: import("@openai/codex-sdk").ThreadOptions) => CodexThreadLike,
 * }} CodexClientLike
 */

/**
 * @typedef {{
 *   createCodex?: (options?: ConstructorParameters<typeof Codex>[0]) => CodexClientLike,
 * }} CodexRunnerDeps
 */

/**
 * @typedef {{
 *   result: AgentResult,
 *   sessionId: string | null,
 * }} CompletedCodexRun
 */

/**
 * Build the prompt sent to Codex for a turn.
 *
 * Codex SDK threads do not expose a first-class system prompt field, so we
 * prepend the resolved system instructions to each turn input.
 * @param {string} prompt
 * @param {string | null | undefined} externalInstructions
 * @returns {string}
 */
export function buildCodexTurnInput(prompt, externalInstructions) {
  const trimmedPrompt = prompt.trim();
  const trimmedExternalInstructions = externalInstructions?.trim() ?? "";
  if (!trimmedExternalInstructions) {
    return trimmedPrompt;
  }
  return [
    "Follow these instructions for this run:",
    trimmedExternalInstructions,
    "",
    "User request:",
    trimmedPrompt,
  ].join("\n");
}

/**
 * Build SDK thread options from the shared harness run config.
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {import("@openai/codex-sdk").ThreadOptions}
 */
export function buildCodexThreadOptions(runConfig) {
  /** @type {import("@openai/codex-sdk").ThreadOptions} */
  const options = {
    skipGitRepoCheck: true,
  };
  if (runConfig?.model) {
    options.model = runConfig.model;
  }
  if (runConfig?.sandboxMode) {
    options.sandboxMode = runConfig.sandboxMode;
  }
  if (runConfig?.workdir) {
    options.workingDirectory = runConfig.workdir;
  }
  if (runConfig?.approvalPolicy) {
    options.approvalPolicy = runConfig.approvalPolicy;
  }
  if (runConfig?.additionalDirectories?.length) {
    options.additionalDirectories = [...runConfig.additionalDirectories];
  }
  return options;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatUsageCost(value) {
  return value.toFixed(6);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
function normalizeCodexEnv(env) {
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

/**
 * Start a Codex SDK-backed run and stream semantic events into harness hooks.
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
 * @param {CodexRunnerDeps} [deps]
 * @returns {Promise<{
 *   abortController: AbortController,
 *   done: Promise<CompletedCodexRun>,
 * }>}
 */
export async function startCodexRun(input, deps = {}) {
  const createCodex = deps.createCodex ?? ((options) => new Codex(options));
  const hooks = { ...DEFAULT_CODEX_RUN_HOOKS, ...input.hooks };
  const abortController = new AbortController();
  const codex = createCodex(input.env ? { env: normalizeCodexEnv({ ...process.env, ...input.env }) } : {});
  const done = (async () => {
    /** @type {string | null | undefined} */
    let currentSessionId = input.sessionId;
    /** @type {HarnessRunConfig | undefined} */
    let currentRunConfig = input.runConfig;

    while (true) {
      const attemptAbortController = new AbortController();
      const forwardAbort = () => {
        attemptAbortController.abort();
      };
      abortController.signal.addEventListener("abort", forwardAbort, { once: true });
      if (abortController.signal.aborted) {
        attemptAbortController.abort();
      }

      try {
        const attempt = await runCodexAttempt({
          chatId: input.chatId,
          prompt: input.prompt,
          externalInstructions: input.externalInstructions,
          messages: input.messages,
          sessionId: currentSessionId ?? null,
          runConfig: currentRunConfig,
          hooks,
          isAborted: input.isAborted,
          codex,
          abortController: attemptAbortController,
        });

        if ("retryRunConfig" in attempt) {
          currentSessionId = attempt.sessionId;
          currentRunConfig = attempt.retryRunConfig;
          continue;
        }

        return attempt;
      } finally {
        abortController.signal.removeEventListener("abort", forwardAbort);
      }
    }
  })();

  return { abortController, done };
}

/**
 * @typedef {{
 *   retryRunConfig: HarnessRunConfig,
 *   sessionId: string | null,
 * }} CodexRunRetry
 */

/**
 * @param {{
 *   chatId: string,
 *   prompt: string,
 *   externalInstructions?: string,
 *   messages: Message[],
 *   sessionId: string | null,
 *   runConfig?: HarnessRunConfig,
 *   hooks: Pick<Required<AgentIOHooks>, "onComposing" | "onPaused" | "onReasoning" | "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
 *   isAborted?: () => boolean,
 *   codex: CodexClientLike,
 *   abortController: AbortController,
 * }} input
 * @returns {Promise<CompletedCodexRun | CodexRunRetry>}
 */
async function runCodexAttempt(input) {
  const threadOptions = buildCodexThreadOptions(input.runConfig);
  const thread = input.sessionId
    ? input.codex.resumeThread(input.sessionId, threadOptions)
    : input.codex.startThread(threadOptions);

  log.info(`Starting Codex SDK run for chat ${input.chatId}`);
  const dispatcher = createCodexEventDispatcher({
    hooks: input.hooks,
    runConfig: input.runConfig,
    messages: input.messages,
  });

  try {
    const turnInput = buildCodexTurnInput(input.prompt, input.externalInstructions);
    const streamed = await thread.runStreamed(turnInput, { signal: input.abortController.signal });

    for await (const event of streamed.events) {
      const normalized = normalizeCodexEvent(event);
      if (!normalized) {
        continue;
      }

      if (normalized.commandEvent?.status === "started") {
        const retryRunConfig = await maybeApproveSandboxEscape({
          command: normalized.commandEvent.command,
          runConfig: input.runConfig,
          hooks: input.hooks,
          sessionId: thread.id,
          abortController: input.abortController,
        });
        if (retryRunConfig) {
          throw new CodexRunRetryError(retryRunConfig, thread.id);
        }
      }
      await dispatcher.handleNormalized(normalized);
    }
  } catch (error) {
    if (error instanceof CodexRunRetryError) {
      return {
        retryRunConfig: error.runConfig,
        sessionId: error.sessionId,
      };
    }
    if (error instanceof CodexSandboxDeniedError) {
      await input.hooks.onToolError(error.message);
      throw new ReportedHarnessRunError(error.message, error);
    }
    if (input.isAborted?.() || isAbortError(error)) {
      return { result: dispatcher.result, sessionId: thread.id };
    }
    throw await reportHarnessRunError(error, input.hooks.onToolError);
  }

  const { result, failureMessage } = dispatcher.finalize();

  if (failureMessage) {
    await input.hooks.onToolError(failureMessage);
    throw new ReportedHarnessRunError(failureMessage);
  }

  if (result.usage.promptTokens > 0 || result.usage.completionTokens > 0 || result.usage.cachedTokens > 0) {
    await input.hooks.onUsage(formatUsageCost(result.usage.cost), {
      prompt: result.usage.promptTokens,
      completion: result.usage.completionTokens,
      cached: result.usage.cachedTokens,
    });
  }

  return { result, sessionId: thread.id };
}

/**
 * @param {{
 *   command: string,
 *   runConfig?: HarnessRunConfig,
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser">,
 *   sessionId: string | null,
 *   abortController: AbortController,
 * }} input
 * @returns {Promise<HarnessRunConfig | null>}
 */
async function maybeApproveSandboxEscape(input) {
  const workdir = typeof input.runConfig?.workdir === "string" ? input.runConfig.workdir : null;
  if (!workdir) {
    return null;
  }

  const request = getCodexSandboxEscapeRequest(input.command, input.runConfig);
  if (!request) {
    return null;
  }

  const allowed = await requestSandboxEscapeApproval(request, input.hooks.onAskUser);
  const additionalDirectory = resolveSandboxApprovalDirectory(request);
  if (!allowed) {
    input.abortController.abort();
    throw new CodexSandboxDeniedError(`Sandbox escape denied for \`${additionalDirectory}\``);
  }

  input.abortController.abort();
  return appendSandboxWritableRoot(input.runConfig, additionalDirectory);
}

/**
 * @param {string} command
 * @param {HarnessRunConfig | undefined} runConfig
 * @returns {{ resolvedTarget?: string, target?: string, workdir: string, command?: string, summary: string, toolName: string, kind: "path" | "command" } | null}
 */
function getCodexSandboxEscapeRequest(command, runConfig) {
  const workdir = typeof runConfig?.workdir === "string" ? runConfig.workdir : null;
  if (!workdir) {
    return null;
  }

  const sandboxOptions = {
    workdir,
    sandboxMode: runConfig?.sandboxMode ?? null,
    additionalWritableRoots: runConfig?.additionalDirectories ?? null,
  };
  const commandSemantics = analyzeCodexCommand(command);
  for (const patch of commandSemantics.patches) {
    const request = getSandboxEscapeRequest("write_file", { file_path: patch.path }, sandboxOptions);
    if (request) {
      return request;
    }
  }
  if (commandSemantics.patches.length > 0) {
    return null;
  }

  return getSandboxEscapeRequest("run_bash", { command }, sandboxOptions);
}

class CodexRunRetryError extends Error {
  /**
   * @param {HarnessRunConfig} runConfig
   * @param {string | null} sessionId
   */
  constructor(runConfig, sessionId) {
    super("Retry Codex run with expanded sandbox.");
    this.name = "CodexRunRetryError";
    /** @type {HarnessRunConfig} */
    this.runConfig = runConfig;
    /** @type {string | null} */
    this.sessionId = sessionId;
  }
}

class CodexSandboxDeniedError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "CodexSandboxDeniedError";
  }
}
