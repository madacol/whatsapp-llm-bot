import { Codex } from "@openai/codex-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { createLogger } from "../logger.js";
import { analyzeCodexCommand } from "./codex-command-semantics.js";
import { normalizeCodexEvent } from "./codex-events.js";

const log = createLogger("harness:codex-runner");

/** @type {Pick<Required<AgentIOHooks>, "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">} */
const DEFAULT_CODEX_RUN_HOOKS = {
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
 *   hooks?: Pick<AgentIOHooks, "onCommand" | "onFileRead" | "onPlan" | "onFileChange" | "onLlmResponse" | "onToolError" | "onUsage">,
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
    /** @type {Map<string, string | null>} */
    const fileSnapshots = new Map();
    /** @type {Map<string, { diff?: string, kind?: "add" | "delete" | "update" }>} */
    const pendingFileDiffs = new Map();

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
          const semantics = analyzeCodexCommand(normalized.commandEvent.command);
          if (normalized.commandEvent.status === "started") {
            await snapshotCommandPaths(input.runConfig?.workdir, semantics.snapshotPaths, fileSnapshots);
            for (const patch of semantics.patches) {
              pendingFileDiffs.set(resolveCommandPath(input.runConfig?.workdir, patch.path), {
                ...(patch.diff ? { diff: patch.diff } : {}),
                kind: patch.kind,
              });
            }
            if (semantics.readPaths.length > 0) {
              await hooks.onFileRead({
                command: normalized.commandEvent.command,
                paths: semantics.readPaths,
              });
              continue;
            }
          }
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
          const enrichedFileChange = await enrichFileChangeEvent(input.runConfig?.workdir, normalized.fileChange, fileSnapshots, pendingFileDiffs);
          await hooks.onFileChange(enrichedFileChange);
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

/**
 * @param {string | null | undefined} workdir
 * @param {string[]} paths
 * @param {Map<string, string | null>} fileSnapshots
 * @returns {Promise<void>}
 */
async function snapshotCommandPaths(workdir, paths, fileSnapshots) {
  for (const relativePath of paths) {
    const absolutePath = resolveCommandPath(workdir, relativePath);
    if (fileSnapshots.has(absolutePath)) {
      continue;
    }
    fileSnapshots.set(absolutePath, await readOptionalText(absolutePath));
  }
}

/**
 * @param {string | null | undefined} workdir
 * @param {{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" }} fileChange
 * @param {Map<string, string | null>} fileSnapshots
 * @param {Map<string, { diff?: string, kind?: "add" | "delete" | "update" }>} pendingFileDiffs
 * @returns {Promise<{ path: string, summary?: string, diff?: string, kind?: "add" | "delete" | "update" }>}
 */
async function enrichFileChangeEvent(workdir, fileChange, fileSnapshots, pendingFileDiffs) {
  const absolutePath = resolveCommandPath(workdir, fileChange.path);
  const pending = pendingFileDiffs.get(absolutePath);
  if (pending) {
    pendingFileDiffs.delete(absolutePath);
  }

  const previousText = fileSnapshots.has(absolutePath)
    ? fileSnapshots.get(absolutePath) ?? null
    : null;
  const nextText = await readOptionalText(absolutePath);
  fileSnapshots.set(absolutePath, nextText);

  const diff = fileChange.diff
    ?? pending?.diff
    ?? buildFileDiff(fileChange.path, previousText, nextText);
  const kind = fileChange.kind ?? pending?.kind ?? inferFileChangeKind(previousText, nextText);

  return {
    ...fileChange,
    ...(kind ? { kind } : {}),
    ...(diff ? { diff } : {}),
  };
}

/**
 * @param {string | null | undefined} workdir
 * @param {string} relativePath
 * @returns {string}
 */
function resolveCommandPath(workdir, relativePath) {
  if (path.isAbsolute(relativePath) || !workdir) {
    return relativePath;
  }
  return path.resolve(workdir, relativePath);
}

/**
 * @param {string} filePath
 * @param {string | null} oldText
 * @param {string | null} newText
 * @returns {string | undefined}
 */
function buildFileDiff(filePath, oldText, newText) {
  if (oldText === newText) {
    return undefined;
  }
  if (oldText == null && newText == null) {
    return undefined;
  }
  const patchText = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, oldText ?? "", newText ?? "", "", "", {
    context: 3,
  });
  const lines = patchText.split("\n");
  return lines.slice(2).join("\n").trim() || undefined;
}

/**
 * @param {string | null} oldText
 * @param {string | null} newText
 * @returns {"add" | "delete" | "update" | undefined}
 */
function inferFileChangeKind(oldText, newText) {
  if (oldText == null && newText != null) {
    return "add";
  }
  if (oldText != null && newText == null) {
    return "delete";
  }
  if (oldText != null && newText != null && oldText !== newText) {
    return "update";
  }
  return undefined;
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
