import { Codex } from "@openai/codex-sdk";
import { createLogger } from "../logger.js";
import { formatToolInspectBody, getToolCallSummary } from "../tool-display.js";
import { createToolMessage, registerInspectHandler } from "../utils.js";
import { normalizeCodexEvent } from "./codex-events.js";
import { analyzeCodexCommand } from "./codex-command-semantics.js";
import { createCodexRunState } from "./codex-run-state.js";
import { getSandboxEscapeRequest } from "./sandbox-approval.js";
import {
  appendSandboxWritableRoot,
  requestSandboxEscapeApproval,
  resolveSandboxApprovalDirectory,
} from "./sandbox-approval-coordinator.js";
import { createCodexSyntheticToolAdapter } from "./codex-synthetic-tools.js";

const log = createLogger("harness:codex-runner");

/** @type {Pick<Required<AgentIOHooks>, "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_CODEX_RUN_HOOKS = {
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
 *   hooks?: Pick<AgentIOHooks, "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
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
  const codex = createCodex({ codexPathOverride: "codex" });
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
 *   messages: Message[],
 *   sessionId: string | null,
 *   runConfig?: HarnessRunConfig,
 *   hooks: Pick<Required<AgentIOHooks>, "onAskUser" | "onToolCall" | "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
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

  /** @type {AgentResult} */
  const result = {
    response: [],
    messages: input.messages,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
  };

  const streamed = await thread.runStreamed(input.prompt, { signal: input.abortController.signal });
  let lastAssistantText = null;
  /** @type {string | null} */
  let failureMessage = null;
  const runState = createCodexRunState({ workdir: input.runConfig?.workdir });
  /** @type {Map<string, { handle: MessageHandle, summary: string, toolName: string, args: Record<string, unknown> }>} */
  const activeTools = new Map();
  const syntheticToolAdapter = createCodexSyntheticToolAdapter({
    onToolCall: input.hooks.onToolCall,
    cwd: input.runConfig?.workdir ?? null,
  });

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
        if (normalized.commandEvent.status === "started") {
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

        const dispatch = await runState.handleCommandEvent(normalized.commandEvent);
        if (normalized.commandEvent.status === "completed") {
          syntheticToolAdapter.handleCommandCompletion(normalized.commandEvent);
        }
        if (dispatch.fileRead) {
          await input.hooks.onFileRead(dispatch.fileRead);
        }
        if (dispatch.command) {
          await input.hooks.onCommand(dispatch.command);
        }
      }

      if (normalized.toolEvent) {
        const currentSummary = getCodexToolSummary(
          normalized.toolEvent.name,
          normalized.toolEvent.arguments,
          input.runConfig?.workdir ?? null,
        );
        if (normalized.toolEvent.status === "started") {
          const toolCall = {
            id: normalized.toolEvent.id,
            name: normalized.toolEvent.name,
            arguments: JSON.stringify(normalized.toolEvent.arguments),
          };
          const handle = await input.hooks.onToolCall(toolCall);
          if (handle) {
            const initialInspectText = formatToolInspectBody(
              normalized.toolEvent.name,
              normalized.toolEvent.arguments,
              undefined,
            );
            if (initialInspectText) {
              registerInspectHandler(
                handle,
                currentSummary,
                createToolMessage(normalized.toolEvent.id, ""),
                normalized.toolEvent.name,
                initialInspectText,
              );
            }
            activeTools.set(normalized.toolEvent.id, {
              handle,
              summary: currentSummary,
              toolName: normalized.toolEvent.name,
              args: normalized.toolEvent.arguments,
            });
          }
        } else {
          let activeTool = activeTools.get(normalized.toolEvent.id);
          if (!activeTool) {
            const toolCall = {
              id: normalized.toolEvent.id,
              name: normalized.toolEvent.name,
              arguments: JSON.stringify(normalized.toolEvent.arguments),
            };
            const handle = await input.hooks.onToolCall(toolCall);
            if (handle) {
              activeTool = {
                handle,
                summary: currentSummary,
                toolName: normalized.toolEvent.name,
                args: normalized.toolEvent.arguments,
              };
            }
          }
          if (activeTool && activeTool.summary !== currentSummary) {
            try {
              await activeTool.handle.edit(currentSummary);
            } catch {
              // best-effort — inspect still works without an in-place update
            }
            activeTool.summary = currentSummary;
          }
          if (activeTool && normalized.toolEvent.output) {
            const inspectText = formatToolInspectBody(
              activeTool.toolName,
              activeTool.args,
              normalized.toolEvent.output,
            ) ?? undefined;
            registerInspectHandler(
              activeTool.handle,
              currentSummary,
              createToolMessage(normalized.toolEvent.id, normalized.toolEvent.output),
              activeTool.toolName,
              inspectText,
            );
          }
          if (activeTool) {
            activeTools.delete(normalized.toolEvent.id);
          }
        }
      }

      if (normalized.assistantText) {
        await syntheticToolAdapter.handleAssistantText(normalized.assistantText);
        lastAssistantText = normalized.assistantText;
        await input.hooks.onLlmResponse(normalized.assistantText);
      }

      if (normalized.planText) {
        await input.hooks.onPlan(normalized.planText);
      }

      if (normalized.fileChange) {
        const enrichedFileChange = await runState.enrichFileChangeEvent(normalized.fileChange);
        await input.hooks.onFileChange(enrichedFileChange);
      }
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
      throw error;
    }
    if (input.isAborted?.() || isAbortError(error)) {
      return { result, sessionId: thread.id };
    }
    throw error;
  }

  if (lastAssistantText) {
    result.response = [{ type: "markdown", text: lastAssistantText }];
  }

  if (failureMessage) {
    await input.hooks.onToolError(failureMessage);
    throw new Error(failureMessage);
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

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null} cwd
 * @returns {string}
 */
function getCodexToolSummary(name, args, cwd) {
  const summary = getToolCallSummary(name, args, undefined, cwd);
  return summary === name ? `*${name}*` : summary;
}
