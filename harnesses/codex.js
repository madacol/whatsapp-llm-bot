/**
 * Codex harness — uses the local Codex SDK for stateful agent runs.
 */

import { createLogger } from "../logger.js";
import { NO_OP_HOOKS } from "./native.js";
import { isHandledCodexRunError, startCodexRun } from "./codex-runner.js";
import { startCodexAppServerRun } from "./codex-app-server-runner.js";
import { extractCodexText } from "./codex-event-utils.js";
import { createCodexCommandHandler } from "./codex-commands.js";
import { getCodexAvailableModels } from "./codex-models.js";
import { buildSdkErrorResponse, clearStaleHarnessSession, getHarnessRunErrorMessage } from "./harness-run-errors.js";
import {
  getCodexSessionId,
  saveCodexSession,
  updateCodexConfig,
} from "./codex-config.js";
export { buildCodexThreadOptions } from "./codex-runner.js";

const log = createLogger("harness:codex");

/** @type {HarnessCapabilities} */
const CODEX_HARNESS_CAPABILITIES = {
  supportsResume: true,
  supportsCancel: true,
  supportsLiveInput: true,
  supportsApprovals: true,
  supportsWorkdir: true,
  supportsSandboxConfig: true,
  supportsModelSelection: true,
  supportsReasoningEffort: false,
  supportsSessionFork: false,
};

/**
 * @param {string} model
 * @returns {boolean}
 */
function isLegacyClaudeModel(model) {
  const normalized = model.trim().toLowerCase();
  return normalized === "sonnet"
    || normalized === "opus"
    || normalized === "haiku"
    || normalized.startsWith("claude");
}

/**
 * @typedef {{
 *   abortController: AbortController;
 *   done: Promise<{ result: AgentResult, sessionId: string | null }>;
 *   steer?: (text: string) => boolean | Promise<boolean>;
 *   interrupt?: () => boolean | Promise<boolean>;
 *   aborted: boolean;
 * }} ActiveCodexRun
 */

/**
 * @typedef {{
 *   getAvailableModels?: () => Promise<Array<{ id: string, label: string }>>,
 *   startRun?: (input: Parameters<typeof startCodexRun>[0]) => Promise<{
 *     abortController: AbortController,
 *     done: Promise<{ result: AgentResult, sessionId: string | null }>,
 *     steer?: (text: string) => boolean | Promise<boolean>,
 *     interrupt?: () => boolean | Promise<boolean>,
 *   }>,
 * }} CodexHarnessDeps
 */

/**
 * Create the Codex harness.
 * @param {CodexHarnessDeps} [deps]
 * @returns {AgentHarness}
 */
export function createCodexHarness(deps = {}) {
  /** @type {Map<string, ActiveCodexRun>} */
  const activeRuns = new Map();
  const loadAvailableModels = deps.getAvailableModels ?? getCodexAvailableModels;
  const beginRun = deps.startRun ?? startCodexAppServerRun;
  const handleCommand = createCodexCommandHandler({
    getAvailableModels: loadAvailableModels,
    cancelActiveQuery: cancel,
  });

  return {
    getName: () => "codex",
    getCapabilities: () => CODEX_HARNESS_CAPABILITIES,
    run,
    handleCommand,
    listSlashCommands,
    injectMessage,
    cancel,
    waitForIdle,
  };

  /**
   * @param {string | HarnessSessionRef} chatId
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function injectMessage(chatId, text) {
    const key = typeof chatId === "string" ? chatId : chatId.id;
    const active = activeRuns.get(key);
    if (!active?.steer || !text) {
      return false;
    }
    return !!(await active.steer(text));
  }

  /**
   * @param {string | HarnessSessionRef} chatId
   * @returns {boolean}
   */
  function cancel(chatId) {
    const key = typeof chatId === "string" ? chatId : chatId.id;
    const active = activeRuns.get(key);
    if (!active) {
      return false;
    }
    active.aborted = true;
    if (active.interrupt) {
      void Promise.resolve(active.interrupt()).catch((error) => {
        log.warn("Codex interrupt failed, falling back to abort:", error);
        active.abortController.abort();
      });
      return true;
    }
    active.abortController.abort();
    return true;
  }

  /**
   * @returns {string[]}
   */
  function listSlashCommands() {
    return ["/clear", "/resume", "/model", "/sandbox", "/permissions", "/approval"];
  }

  /**
   * @returns {Promise<string[]>}
   */
  async function waitForIdle() {
    const chatIds = [...activeRuns.keys()];
    await Promise.allSettled(chatIds.map((chatId) => activeRuns.get(chatId)?.done));
    return chatIds;
  }

  /**
   * @param {AgentHarnessParams} params
   * @returns {Promise<AgentResult>}
   */
  async function run({ session, llmConfig, messages, hooks: userHooks, runConfig }) {
    const hooks = { ...NO_OP_HOOKS, ...userHooks };
    const prompt = extractCodexText(messages.at(-1)?.content) ?? "";
    if (!prompt) {
      return {
        response: [{ type: "text", text: "No input message found." }],
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    }

    const sessionId = getCodexSessionId(session);
    const effectiveRunConfig = await sanitizeRunConfig(session.chatId, runConfig);
    /** @type {ActiveCodexRun | null} */
    let activeRun = null;
    try {
      const started = await beginRun({
        chatId: session.chatId,
        prompt,
        externalInstructions: llmConfig.externalInstructions,
        messages,
        sessionId,
        runConfig: effectiveRunConfig,
        hooks,
        isAborted: () => activeRun?.aborted ?? false,
      });
      activeRun = {
        abortController: started.abortController,
        done: started.done,
        ...(started.steer && { steer: started.steer }),
        ...(started.interrupt && { interrupt: started.interrupt }),
        aborted: false,
      };
      activeRuns.set(session.chatId, activeRun);

      const completed = await started.done;

      if (completed.sessionId && completed.sessionId !== sessionId) {
        await saveCodexSession(session, completed.sessionId);
      }

      return completed.result;
    } catch (error) {
      await clearStaleHarnessSession({
        existingSessionId: sessionId,
        clearSession: async () => saveCodexSession(session, null),
        log,
        harnessLabel: "Codex",
      });

      const errorMessage = getHarnessRunErrorMessage(error);
      if (!isHandledCodexRunError(error)) {
        await hooks.onToolError(errorMessage);
      }
      return {
        response: buildSdkErrorResponse(errorMessage),
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    } finally {
      activeRuns.delete(session.chatId);
    }
  }

  /**
   * Drop invalid persisted model overrides before starting the Codex CLI.
   * This prevents stale Claude selections like `sonnet` from poisoning Codex runs.
   * @param {string} chatId
   * @param {HarnessRunConfig | undefined} runConfig
   * @returns {Promise<HarnessRunConfig | undefined>}
   */
  async function sanitizeRunConfig(chatId, runConfig) {
    if (!runConfig?.model) {
      return runConfig;
    }

    const modelOptions = await loadAvailableModels();
    const modelIsAvailable = modelOptions.some((option) => option.id === runConfig.model);
    const mustClearModel = modelOptions.length > 0
      ? !modelIsAvailable
      : isLegacyClaudeModel(runConfig.model);

    if (!mustClearModel) {
      return runConfig;
    }

    log.warn(`Ignoring invalid Codex model "${runConfig.model}" for chat ${chatId}`);
    await updateCodexConfig(chatId, { model: null });
    return {
      ...runConfig,
      model: undefined,
    };
  }
}
