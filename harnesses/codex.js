import { ATTACHMENT_ROOT, hasMediaPath } from "../attachment-paths.js";
/**
 * Codex harness — uses the local Codex SDK for stateful agent runs.
 */

import { createLogger } from "../logger.js";
import { getChatDb } from "../db.js";
import { NO_OP_HOOKS } from "./native.js";
import { isHandledCodexRunError, startCodexRun } from "./codex-runner.js";
import { startCodexAppServerRun } from "./codex-app-server-runner.js";
import { createCodexCommandHandler } from "./codex-commands.js";
import { getCodexAvailableModels } from "./codex-models.js";
import { augmentLatestUserMessageForTextHarness, buildTextHarnessPromptFromBlocks } from "./prompt-media.js";
import { buildSdkErrorResponse, clearStaleHarnessSession, getHarnessRunErrorMessage } from "./harness-run-errors.js";
import { wrapHooksWithFallbacks } from "./hook-fallbacks.js";
import { createActionRequestRunState, executeQueuedActionRequests } from "../action-request-runtime.js";
import { createActiveSessionDirectory } from "./active-session-directory.js";
import { createHarnessEventStreamController } from "./adapter.js";
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
  supportsSessionFork: true,
};

/**
 * @param {string | undefined} input
 * @param {Message[] | undefined} messages
 * @returns {{ prompt: string, messages: Message[] }}
 */
function buildSemanticCodexPrompt(input, messages) {
  if (messages?.length) {
    return {
      prompt: input?.trim() || buildCodexPrompt(messages),
      messages,
    };
  }
  /** @type {UserMessage} */
  const message = {
    role: "user",
    content: input?.trim()
      ? [{ type: "text", text: input }]
      : [],
  };
  return {
    prompt: input?.trim() ?? "",
    messages: [message],
  };
}

/**
 * @param {string} rawArguments
 * @returns {Record<string, unknown>}
 */
function parseRuntimeToolArguments(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * @param {ToolContentBlock[]} blocks
 * @returns {string}
 */
function summarizeToolBlocks(blocks) {
  return blocks
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : `[${block.type}]`))
    .join("\n");
}

/**
 * @param {ReturnType<typeof createHarnessEventStreamController>} events
 * @returns {AgentIOHooks}
 */
function createCodexEventHooks(events) {
  /** @type {Map<string, { id: string, name: string, arguments: Record<string, unknown> }>} */
  const activeTools = new Map();

  /**
   * @param {string} toolName
   * @returns {{ id: string, name: string, arguments: Record<string, unknown> }}
   */
  function takeActiveTool(toolName) {
    const matching = [...activeTools.values()].find((tool) => tool.name === toolName);
    const tool = matching ?? activeTools.values().next().value ?? {
      id: `codex-tool:${Date.now()}`,
      name: toolName,
      arguments: {},
    };
    activeTools.delete(tool.id);
    return tool;
  }

  return wrapHooksWithFallbacks({
    ...NO_OP_HOOKS,
    async onReasoning(event) {
      events.emit({
        type: event.status === "completed" ? "reasoning.completed" : event.status === "started" ? "reasoning.started" : "reasoning.updated",
        status: event.status,
        text: event.text ?? event.contentParts.join(""),
        summaryParts: event.summaryParts,
        contentParts: event.contentParts,
      });
    },
    async onLlmResponse(text) {
      events.emit({
        type: "assistant.completed",
        text,
        displayText: text,
        contentType: "markdown",
        responseMode: "replace",
      });
    },
    async onUsage(cost, tokens) {
      events.emit({
        type: "usage.updated",
        usage: {
          promptTokens: tokens.prompt,
          completionTokens: tokens.completion,
          cachedTokens: tokens.cached,
          cost: Number.parseFloat(cost) || 0,
          ...(tokens.total !== undefined ? { totalTokens: tokens.total } : {}),
          ...(tokens.reasoning !== undefined ? { reasoningTokens: tokens.reasoning } : {}),
          ...(tokens.contextWindow !== undefined ? { contextWindow: tokens.contextWindow } : {}),
        },
      });
    },
    async onFileChange(change) {
      events.emit({ type: "file-change.completed", change });
    },
    async onToolCall(toolCall) {
      const tool = {
        id: toolCall.id,
        name: toolCall.name,
        arguments: parseRuntimeToolArguments(toolCall.arguments),
      };
      activeTools.set(tool.id, tool);
      events.emit({
        type: "tool.started",
        tool,
      });
    },
    async onToolComplete(toolCall) {
      const tool = takeActiveTool(toolCall.name);
      events.emit({
        type: "tool.completed",
        tool,
      });
    },
    async onToolResult(blocks, toolName, permissions) {
      const tool = takeActiveTool(toolName);
      events.emit({
        type: "tool.completed",
        tool: {
          ...tool,
          output: summarizeToolBlocks(blocks),
          outputBlocks: blocks,
          permissions,
        },
      });
    },
    async onToolError(error) {
      events.emit({
        type: "tool.failed",
        tool: {
          id: `codex-error:${Date.now()}`,
          name: "codex",
          arguments: {},
          output: error,
        },
      });
    },
  });
}

/**
 * @param {Message[]} messages
 * @returns {boolean}
 */
function hasPathAddressedMedia(messages) {
  /**
   * @param {IncomingContentBlock[]} blocks
   * @returns {boolean}
   */
  const visit = (blocks) => blocks.some((block) => {
    if (block.type === "quote") {
      return visit(block.content);
    }
    return (block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file")
      && hasMediaPath(block);
  });
  return messages.some((message) => message.role === "user" && visit(message.content));
}

/**
 * @param {HarnessRunConfig | undefined} runConfig
 * @param {Message[]} messages
 * @returns {HarnessRunConfig | undefined}
 */
function addAttachmentRootToRunConfig(runConfig, messages) {
  if (!hasPathAddressedMedia(messages)) {
    return runConfig;
  }
  const existing = runConfig?.additionalDirectories ?? [];
  if (existing.includes(ATTACHMENT_ROOT)) {
    return runConfig;
  }
  return {
    ...(runConfig ?? {}),
    additionalDirectories: [...existing, ATTACHMENT_ROOT],
  };
}

/**
 * Build the text prompt that Codex should see for the current turn.
 * The Codex harness chooses a text-only representation, appending canonical
 * media file paths so the agent can refer to them explicitly.
 * @param {Message[]} messages
 * @returns {string}
 */
function buildCodexPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") {
      continue;
    }
    return buildTextHarnessPromptFromBlocks(msg.content);
  }
  return "";
}

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
 *   readThread?: Parameters<typeof createCodexCommandHandler>[0]["readThread"],
 *   forkThread?: Parameters<typeof createCodexCommandHandler>[0]["forkThread"],
 *   getApprovalPolicyOptions?: Parameters<typeof createCodexCommandHandler>[0]["getApprovalPolicyOptions"],
 *   getSandboxModeOptions?: Parameters<typeof createCodexCommandHandler>[0]["getSandboxModeOptions"],
 *   getApprovalsReviewerOptions?: Parameters<typeof createCodexCommandHandler>[0]["getApprovalsReviewerOptions"],
 * }} CodexHarnessDeps
 */

/**
 * Create the Codex harness.
 * @param {CodexHarnessDeps} [deps]
 * @returns {AgentHarness}
 */
export function createCodexHarness(deps = {}) {
  const activeSessions = createActiveSessionDirectory({
    label: "Codex",
    onInterruptError: (error) => {
      log.warn("Codex interrupt failed, falling back to abort:", error);
    },
  });
  const loadAvailableModels = deps.getAvailableModels ?? getCodexAvailableModels;
  const beginRun = deps.startRun ?? startCodexAppServerRun;
  const handleCommand = createCodexCommandHandler({
    getAvailableModels: loadAvailableModels,
    cancelActiveQuery: cancel,
    readThread: deps.readThread,
    forkThread: deps.forkThread,
    getApprovalPolicyOptions: deps.getApprovalPolicyOptions,
    getSandboxModeOptions: deps.getSandboxModeOptions,
    getApprovalsReviewerOptions: deps.getApprovalsReviewerOptions,
  });
  /** @type {Map<string, HarnessRuntimeSession>} */
  const adapterSessions = new Map();
  const adapter = createAdapter({
    name: "codex",
    instanceId: "default",
    continuationKey: "codex:instance:default",
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
    createAdapter,
  };

  /**
   * @param {HarnessAdapterCreateInput} input
   * @returns {HarnessAdapter}
   */
  function createAdapter(input) {
    const instanceContinuationKey = input.continuationKey;
    const instanceId = input.instanceId;
    const harnessName = input.name;
    const events = createHarnessEventStreamController(harnessName);
    return {
      supportsSemanticTurns: true,
      async startSession({ chatId, runConfig, resumeCursor }) {
        /** @type {HarnessRuntimeSession} */
        const session = {
          chatId,
          harnessName,
          instanceId,
          continuationKey: instanceContinuationKey,
          status: "ready",
          workdir: runConfig?.workdir ?? null,
          model: runConfig?.model ?? null,
          ...(resumeCursor ? { resumeCursor } : {}),
        };
        adapterSessions.set(chatId, session);
        events.emit({ type: "session.started", session });
        return session;
      },
      async sendTurn(request) {
        if ("turn" in request) {
          return runCodexSemanticTurn(request.turn, {
            instanceId,
            harnessName,
            continuationKey: instanceContinuationKey,
            events,
          });
        }
        const { params } = request;
        return runCodexTurn(params, {
          instanceId,
          harnessName,
          continuationKey: instanceContinuationKey,
        });
      },
      async interruptTurn({ chatId }) {
        return cancel(chatId);
      },
      async injectMessage(chatId, text) {
        return activeSessions.injectMessage(chatId, text);
      },
      async stopSession(chatId) {
        const key = typeof chatId === "string" ? chatId : chatId.id;
        adapterSessions.delete(key);
        events.emit({
          type: "session.stopped",
          session: {
            chatId: key,
            harnessName,
            instanceId,
            continuationKey: instanceContinuationKey,
            status: "stopped",
          },
        });
        return cancel(chatId);
      },
      listSessions() {
        return [...adapterSessions.values()];
      },
      async readThread(_sessionId) {
        return null;
      },
      async rollbackThread(_sessionId, _numTurns) {
        return null;
      },
      streamEvents: events.stream,
      subscribeEvents: events.subscribe,
    };
  }

  /**
   * @param {string | HarnessSessionRef} chatId
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function injectMessage(chatId, text) {
    return activeSessions.injectMessage(chatId, text);
  }

  /**
   * @param {string | HarnessSessionRef} chatId
   * @returns {boolean}
   */
  function cancel(chatId) {
    return activeSessions.cancel(chatId);
  }

  /**
   * @returns {SlashCommandDescriptor[]}
   */
  function listSlashCommands() {
    return [
      { name: "clear", description: "Clear the current harness session" },
      { name: "resume", description: "Restore a previously cleared harness session" },
      { name: "fork", description: "Fork the current Codex thread" },
      { name: "back", description: "Return to the previous Codex fork parent" },
      { name: "model", description: "Choose or set the Codex model" },
      { name: "sandbox", description: "Alias of /permissions" },
      { name: "permissions", description: "Show or set the Codex permissions mode" },
      { name: "approval", description: "Show or set the Codex approval policy" },
    ];
  }

  /**
   * @returns {Promise<string[]>}
   */
  async function waitForIdle() {
    return activeSessions.waitForIdle();
  }

  /**
   * @param {AgentHarnessParams} params
   * @returns {Promise<AgentResult>}
   */
  async function run(params) {
    return adapter.sendTurn({ params });
  }

  /**
   * @param {HarnessSemanticTurnInput} turn
   * @param {{
   *   instanceId: string,
   *   harnessName: string,
   *   continuationKey: string,
   *   events: ReturnType<typeof createHarnessEventStreamController>,
   * }} adapterIdentity
   * @returns {Promise<AgentResult>}
   */
  async function runCodexSemanticTurn(turn, adapterIdentity) {
    const semanticPrompt = buildSemanticCodexPrompt(turn.input, turn.messages);
    const { prompt, messages } = semanticPrompt;
    if (!prompt) {
      return {
        response: [{ type: "text", text: "No input message found." }],
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    }

    const existingAdapterSession = adapterSessions.get(turn.chatId);
    const sessionId = turn.resumeCursor ?? existingAdapterSession?.resumeCursor ?? null;
    const effectiveRunConfig = addAttachmentRootToRunConfig(
      await sanitizeRunConfig(turn.chatId, turn.runConfig),
      messages,
    );
    /** @type {ActiveCodexRun | null} */
    let activeRun = null;
    adapterSessions.set(turn.chatId, {
      chatId: turn.chatId,
      harnessName: adapterIdentity.harnessName,
      instanceId: adapterIdentity.instanceId,
      continuationKey: adapterIdentity.continuationKey,
      status: "running",
      workdir: effectiveRunConfig?.workdir ?? null,
      model: effectiveRunConfig?.model ?? null,
      ...(sessionId ? { resumeCursor: sessionId } : {}),
    });
    const runningSession = adapterSessions.get(turn.chatId);
    if (runningSession) {
      adapterIdentity.events.emit({ type: "session.updated", session: runningSession });
    }
    adapterIdentity.events.emit({
      type: "turn.started",
      turn: { id: turn.chatId, chatId: turn.chatId, status: "started" },
    });
    const hooks = createCodexEventHooks(adapterIdentity.events);
    try {
      const started = await beginRun({
        chatId: turn.chatId,
        prompt,
        externalInstructions: turn.externalInstructions,
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
      activeSessions.register(turn.chatId, activeRun);

      const completed = await started.done;
      const readySession = {
        ...(adapterSessions.get(turn.chatId) ?? existingAdapterSession ?? {
          chatId: turn.chatId,
          harnessName: adapterIdentity.harnessName,
          instanceId: adapterIdentity.instanceId,
          continuationKey: adapterIdentity.continuationKey,
        }),
        status: "ready",
        resumeCursor: completed.sessionId ?? sessionId ?? null,
      };
      adapterSessions.set(turn.chatId, /** @type {HarnessRuntimeSession} */ (readySession));
      adapterIdentity.events.emit({ type: "session.updated", session: readySession });
      adapterIdentity.events.emit({
        type: "turn.completed",
        turn: { id: turn.chatId, chatId: turn.chatId, status: "completed" },
      });
      return completed.result;
    } catch (error) {
      const current = adapterSessions.get(turn.chatId);
      if (current) {
        const stopped = /** @type {HarnessRuntimeSession} */ ({ ...current, status: "stopped" });
        adapterSessions.set(turn.chatId, stopped);
        adapterIdentity.events.emit({ type: "session.updated", session: stopped });
      }
      await clearStaleHarnessSession({
        existingSessionId: sessionId,
        error,
        clearSession: async () => {
          const latest = adapterSessions.get(turn.chatId);
          const cleared = /** @type {HarnessRuntimeSession} */ ({
            ...(latest ?? {
              chatId: turn.chatId,
              harnessName: adapterIdentity.harnessName,
              instanceId: adapterIdentity.instanceId,
              continuationKey: adapterIdentity.continuationKey,
            }),
            status: "stopped",
            resumeCursor: null,
          });
          adapterSessions.set(turn.chatId, cleared);
          adapterIdentity.events.emit({ type: "session.updated", session: cleared });
        },
        log,
        harnessLabel: "Codex",
      });
      const errorMessage = getHarnessRunErrorMessage(error);
      if (!isHandledCodexRunError(error)) {
        await hooks.onToolError?.(errorMessage);
      }
      adapterIdentity.events.emit({
        type: "turn.completed",
        turn: { id: turn.chatId, chatId: turn.chatId, status: "failed" },
      });
      return {
        response: buildSdkErrorResponse(errorMessage),
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    } finally {
      if (activeRun) {
        activeSessions.unregister(turn.chatId, activeRun);
      }
    }
  }

  /**
   * @param {AgentHarnessParams} params
   * @param {{ instanceId: string, harnessName: string, continuationKey: string }} adapterIdentity
   * @returns {Promise<AgentResult>}
   */
  async function runCodexTurn({ session, llmConfig, messages, hooks: userHooks, runConfig }, adapterIdentity) {
    const hooks = wrapHooksWithFallbacks({ ...NO_OP_HOOKS, ...userHooks });
    const promptMessages = await augmentLatestUserMessageForTextHarness(messages, llmConfig, getChatDb(session.chatId));
    const prompt = buildCodexPrompt(promptMessages);
    if (!prompt) {
      return {
        response: [{ type: "text", text: "No input message found." }],
        messages,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
      };
    }

    const sessionId = getCodexSessionId(session);
    const effectiveRunConfig = addAttachmentRootToRunConfig(
      await sanitizeRunConfig(session.chatId, runConfig),
      messages,
    );
    const effectiveWorkdir = effectiveRunConfig?.workdir ?? process.cwd();
    const actionRequestState = createActionRequestRunState(effectiveWorkdir);
    /** @type {ActiveCodexRun | null} */
    let activeRun = null;
    const existingAdapterSession = adapterSessions.get(session.chatId);
    adapterSessions.set(session.chatId, {
      chatId: session.chatId,
      harnessName: adapterIdentity.harnessName,
      instanceId: adapterIdentity.instanceId,
      continuationKey: adapterIdentity.continuationKey,
      status: "running",
      workdir: effectiveRunConfig?.workdir ?? null,
      model: effectiveRunConfig?.model ?? null,
      ...(sessionId ? { resumeCursor: sessionId } : {}),
    });
    try {
      const started = await beginRun({
        chatId: session.chatId,
        prompt,
        externalInstructions: llmConfig.externalInstructions,
        messages,
        sessionId,
        runConfig: effectiveRunConfig,
        env: { ...process.env, ...actionRequestState.env },
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
      activeSessions.register(session.chatId, activeRun);

      const completed = await started.done;

      if (completed.sessionId && completed.sessionId !== sessionId) {
        await saveCodexSession(session, completed.sessionId);
      }
      adapterSessions.set(session.chatId, {
        ...(adapterSessions.get(session.chatId) ?? existingAdapterSession ?? {
          chatId: session.chatId,
          harnessName: adapterIdentity.harnessName,
          instanceId: adapterIdentity.instanceId,
          continuationKey: adapterIdentity.continuationKey,
        }),
        status: "ready",
        resumeCursor: completed.sessionId ?? sessionId ?? null,
      });

      const queuedBlocks = await executeQueuedActionRequests(actionRequestState.requestsDir, {
        toolRuntime: llmConfig.toolRuntime,
        session,
        hooks,
        messages,
        runConfig: effectiveRunConfig,
      });
      if (queuedBlocks.length > 0) {
        const blocks = queuedBlocks;
        completed.result.response = blocks;
      }

      return completed.result;
    } catch (error) {
      const current = adapterSessions.get(session.chatId);
      if (current) {
        adapterSessions.set(session.chatId, { ...current, status: "stopped" });
      }
      await clearStaleHarnessSession({
        existingSessionId: sessionId,
        error,
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
      if (activeRun) {
        activeSessions.unregister(session.chatId, activeRun);
      }
      await actionRequestState.cleanup();
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
