import { Codex } from "@openai/codex-sdk";
import { createLogger } from "../logger.js";
import { normalizeCodexEvent } from "./codex-events.js";

const log = createLogger("harness:codex-runner");

/** @type {Pick<Required<AgentIOHooks>, "onCommand" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_CODEX_RUN_HOOKS = {
  onCommand: async () => {},
  onPlan: async () => {},
  onFileChange: async () => {},
  onLlmResponse: async () => {},
  onToolError: async () => {},
  onUsage: async () => {},
};

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
 *   messages: Message[],
 *   sessionId?: string | null,
 *   runConfig?: HarnessRunConfig,
 *   hooks?: Pick<AgentIOHooks, "onCommand" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
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
  const threadOptions = buildCodexThreadOptions(input.runConfig);
  const codex = createCodex({ codexPathOverride: "codex" });
  const thread = input.sessionId
    ? codex.resumeThread(input.sessionId, threadOptions)
    : codex.startThread(threadOptions);

  log.info(`Starting Codex SDK run for chat ${input.chatId}`);

  /** @type {AgentResult} */
  const result = {
    response: [],
    messages: input.messages,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
  };

  const streamed = await thread.runStreamed(input.prompt, { signal: abortController.signal });

  const done = (async () => {
    let lastAssistantText = null;
    /** @type {string | null} */
    let failureMessage = null;

    try {
      for await (const event of streamed.events) {
        const normalized = normalizeCodexEvent(event);
        if (!normalized) {
          continue;
        }

        if (normalized.usage) {
          result.usage = normalized.usage;
        }

        if (normalized.failureMessage) {
          failureMessage = normalized.failureMessage;
        }

        if (normalized.commandEvent) {
          await hooks.onCommand(normalized.commandEvent);
        }

        if (normalized.assistantText) {
          lastAssistantText = normalized.assistantText;
          await hooks.onLlmResponse(normalized.assistantText);
        }

        if (normalized.planText) {
          await hooks.onPlan(normalized.planText);
        }

        if (normalized.fileChange) {
          await hooks.onFileChange(normalized.fileChange);
        }
      }
    } catch (error) {
      if (input.isAborted?.() || isAbortError(error)) {
        return { result, sessionId: thread.id };
      }
      throw error;
    }

    if (lastAssistantText) {
      result.response = [{ type: "markdown", text: lastAssistantText }];
    }

    if (failureMessage) {
      await hooks.onToolError(failureMessage);
      throw new Error(failureMessage);
    }

    if (result.usage.promptTokens > 0 || result.usage.completionTokens > 0 || result.usage.cachedTokens > 0) {
      await hooks.onUsage(formatUsageCost(result.usage.cost), {
        prompt: result.usage.promptTokens,
        completion: result.usage.completionTokens,
        cached: result.usage.cachedTokens,
      });
    }

    return { result, sessionId: thread.id };
  })();

  return { abortController, done };
}
