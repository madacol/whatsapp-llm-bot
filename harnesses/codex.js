/**
 * Codex harness — uses the local Codex SDK for stateful agent runs.
 */

import { createLogger } from "../logger.js";
import { errorToString } from "../utils.js";
import { NO_OP_HOOKS } from "./native.js";
import { isHandledCodexRunError, startCodexRun } from "./codex-runner.js";
import { extractCodexText } from "./codex-event-utils.js";
import { createCodexCommandHandler } from "./codex-commands.js";
import { getCodexAvailableModels } from "./codex-models.js";
import {
  getCodexSessionId,
  saveCodexSession,
} from "./codex-config.js";
export { buildCodexThreadOptions } from "./codex-runner.js";

const log = createLogger("harness:codex");

/** @type {HarnessCapabilities} */
const CODEX_HARNESS_CAPABILITIES = {
  supportsResume: true,
  supportsCancel: true,
  supportsLiveInput: false,
  supportsApprovals: true,
  supportsWorkdir: true,
  supportsSandboxConfig: true,
  supportsModelSelection: true,
  supportsReasoningEffort: false,
  supportsSessionFork: false,
};

/**
 * @typedef {{
 *   abortController: AbortController;
 *   done: Promise<{ result: AgentResult, sessionId: string | null }>;
 *   aborted: boolean;
 * }} ActiveCodexRun
 */

/**
 * @typedef {{
 *   getAvailableModels?: () => Promise<Array<{ id: string, label: string }>>,
 *   startRun?: typeof startCodexRun,
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
  const beginRun = deps.startRun ?? startCodexRun;
  const handleCommand = createCodexCommandHandler({
    getAvailableModels: loadAvailableModels,
    cancelActiveQuery: cancel,
  });

  return {
    getName: () => "codex",
    getCapabilities: () => CODEX_HARNESS_CAPABILITIES,
    run,
    handleCommand,
    cancel,
    waitForIdle,
  };

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
    active.abortController.abort();
    return true;
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
    /** @type {ActiveCodexRun | null} */
    let activeRun = null;
    try {
      const started = await beginRun({
        chatId: session.chatId,
        prompt,
        externalInstructions: llmConfig.externalInstructions,
        messages,
        sessionId,
        runConfig,
        hooks,
        isAborted: () => activeRun?.aborted ?? false,
      });
      activeRun = {
        abortController: started.abortController,
        done: started.done,
        aborted: false,
      };
      activeRuns.set(session.chatId, activeRun);

      const completed = await started.done;

      if (completed.sessionId && completed.sessionId !== sessionId) {
        await saveCodexSession(session, completed.sessionId);
      }

      return completed.result;
    } catch (error) {
      if (sessionId) {
        log.warn(`Codex run failed for saved session ${sessionId}; clearing persisted session`);
        try {
          await saveCodexSession(session, null);
        } catch (clearError) {
          log.error("Failed to clear stale Codex session ID:", clearError);
        }
      }

      const errorMessage = errorToString(error);
      if (!isHandledCodexRunError(error)) {
        await hooks.onToolError(errorMessage);
      }
      return {
        response: [{ type: "text", text: `SDK error: ${errorMessage}` }],
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    } finally {
      activeRuns.delete(session.chatId);
    }
  }
}
