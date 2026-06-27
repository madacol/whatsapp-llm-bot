import { getAgent } from "../agents.js";
import { getHarnessInstanceConfig } from "../harness-config.js";
import { createAgentRunOutputPort } from "../agent-run-output-port.js";
import { appendUniqueContentBlocks, getDeliveredContentSignature } from "../content-signature.js";
import { errorToString } from "../utils.js";
import { resolveOutputVisibility } from "../chat-output-visibility.js";
import {
  createHarnessRuntimeEventDispatcher,
  resolveHarnessInstance,
  resolveHarnessName,
  createHarnessRunCoordinator,
  getHarnessSessionDirectory,
} from "#harnesses";
import { buildAgentIoHooks } from "./build-agent-io-hooks.js";
import { buildHarnessTurnInput } from "./build-harness-turn-input.js";
import { buildRunConfig } from "./build-run-config.js";
import { createHarnessSessionBindingService } from "./harness-session-binding.js";
import { createAgentSessionPersistence } from "./session-persistence.js";

const NO_LIVE_INPUT_TARGET = Object.freeze({ supportsLiveInput: false });

/**
 * @param {Set<string>} signatures
 * @param {SendContent} content
 * @returns {void}
 */
function addDeliveredContentSignatures(signatures, content) {
  signatures.add(getDeliveredContentSignature(content));
  const blocks = Array.isArray(content) ? content
    : typeof content === "object" && content !== null ? [content]
      : [];
  for (const block of blocks) {
    signatures.add(getDeliveredContentSignature(block));
  }
}

/**
 * @param {ToolContentBlock[]} blocks
 * @param {Set<string>} deliveredContentSignatures
 * @returns {ToolContentBlock[]}
 */
function filterUndeliveredContentBlocks(blocks, deliveredContentSignatures) {
  return blocks.filter((block) => !deliveredContentSignatures.has(getDeliveredContentSignature(block)));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the chat route from a provider runtime event when the adapter exposes
 * one. Older adapters may emit unscoped single-turn events; those remain
 * accepted for compatibility.
 * @param {Record<string, unknown>} event
 * @returns {string | null}
 */
function getRuntimeEventChatId(event) {
  if (typeof event.chatId === "string") {
    return event.chatId;
  }
  if (isRecord(event.session) && typeof event.session.chatId === "string") {
    return event.session.chatId;
  }
  if (isRecord(event.turn) && typeof event.turn.chatId === "string") {
    return event.turn.chatId;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} event
 * @param {string} chatId
 * @returns {boolean}
 */
function isRuntimeEventForChat(event, chatId) {
  const eventChatId = getRuntimeEventChatId(event);
  return eventChatId === null || eventChatId === chatId;
}

/**
 * @param {{ type: string } & Record<string, unknown>} event
 * @param {{ chatId: string, turnId: string, providerInstanceId: string }} activeTurn
 * @returns {boolean}
 */
function isRuntimeEventForActiveProviderTurn(event, activeTurn) {
  if (!isRuntimeEventForChat(event, activeTurn.chatId)) {
    return false;
  }
  if (typeof event.providerInstanceId === "string" && event.providerInstanceId !== activeTurn.providerInstanceId) {
    return false;
  }
  if (typeof event.turnId === "string" && event.turnId !== activeTurn.turnId) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableRuntimeSelectionValue(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableRuntimeSelectionValue).join(",")}]`;
  }
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableRuntimeSelectionValue(entry)}`).join(",")}}`;
}

/**
 * @param {{
 *   selectedRuntimeName: string | null,
 *   runtimeName: string | null,
 *   instanceId: string | null,
 *   config: Record<string, unknown> | null,
 *   displayName?: string,
 * }} selection
 * @returns {string}
 */
function createRuntimeSelectionOwnerKey(selection) {
  return stableRuntimeSelectionValue({
    selectedRuntimeName: selection.selectedRuntimeName,
    runtimeName: selection.runtimeName,
    instanceId: selection.instanceId,
    config: selection.config,
    displayName: selection.displayName ?? null,
  });
}

/**
 * @param {string} chatId
 * @param {number} sequence
 * @returns {string}
 */
function createRuntimeTurnId(chatId, sequence) {
  return `${chatId}:${Date.now()}:${sequence}`;
}

/**
 * @param {IncomingContentBlock[]} content
 * @param {Map<string, number>} [counts]
 * @returns {Map<string, number>}
 */
function collectContentTypeCounts(content, counts = new Map()) {
  for (const block of content) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
    if (block.type === "quote") {
      collectContentTypeCounts(block.content, counts);
    }
  }
  return counts;
}

/**
 * @param {IncomingContentBlock[]} content
 * @returns {string}
 */
function summarizeContentTypes(content) {
  return [...collectContentTypeCounts(content)]
    .map(([type, count]) => `${type}:${count}`)
    .join(",");
}

/**
 * Pick the live-input surface for a run. Semantic adapters own provider-native
 * turn state, so provider live input must inject through the adapter.
 * @param {ReturnType<typeof resolveHarnessInstance> | null} runtimeInstance
 * @returns {{ supportsLiveInput: boolean, injectMessage?: AgentHarness["injectMessage"] }}
 */
function resolveProviderLiveInputTarget(runtimeInstance) {
  if (!runtimeInstance?.adapter || !runtimeInstance.capabilities.supportsLiveInput) {
    return NO_LIVE_INPUT_TARGET;
  }
  return {
    supportsLiveInput: true,
    injectMessage: runtimeInstance.adapter.injectMessage.bind(runtimeInstance.adapter),
  };
}

/**
 * @param {AgentRuntimeSelection} selection
 * @returns {{ persona: AgentDefinition | null, harness: AgentHarness | null, harnessInstance: ReturnType<typeof resolveHarnessInstance> | null }}
 */
function materializeRuntimeSelection(selection) {
  if (!selection.runtimeName) {
    return {
      persona: selection.persona,
      harness: null,
      harnessInstance: null,
    };
  }
  const harnessInstance = resolveHarnessInstance(selection.runtimeName, {
    instanceId: selection.instanceId,
    config: selection.config ?? {},
    displayName: selection.displayName,
  });
  return {
    persona: selection.persona,
    harness: harnessInstance.harness,
    harnessInstance,
  };
}

/**
 * @typedef {{
 *   persona: AgentDefinition | null,
 *   selectedRuntimeName: string | null,
 *   runtimeName: string | null,
 *   instanceId: string | null,
 *   config: Record<string, unknown> | null,
 *   displayName?: string,
 *   ownerKey: string,
 * }} AgentRuntimeSelection
 *
 * @typedef {{
 *   store: import("../store.js").Store,
 *   llmClient: LlmClient,
 *   log: Pick<Console, "debug" | "info" | "warn" | "error">,
 * }} AgentRuntimeDeps
 */

/**
 * Create the Agent Runtime facade used by Turn Orchestration.
 * @param {AgentRuntimeDeps} deps
 * @returns {{
 *   resolveSelection: (chatInfo: import("../store.js").ChatRow | undefined) => Promise<AgentRuntimeSelection>,
 *   hasSelectedRuntime: (selection: AgentRuntimeSelection) => boolean,
 *   hasPendingRun: (chatId: string) => boolean,
 *   beginRun: (input: { turn: ChannelInput, userText: string, selection: AgentRuntimeSelection, allowLiveInputTarget?: boolean }) => Promise<{ status: "started" | "buffered" | "injected", reason?: "pending-setup" | "active-run" | "live-input-retry" }>,
 *   preparePendingLiveInputReplay: (chatId: string, turn: ChannelInput) => { turn: ChannelInput, text: string } | null,
 *   interruptTurn: (selection: AgentRuntimeSelection, chatId: string) => Promise<boolean>,
 *   finishRun: (chatId: string) => ChannelInput | null,
 *   runStartedTurn: (input: {
 *     turn: ChannelInput,
 *     chatInfo: import("../store.js").ChatRow | undefined,
 *     context: ExecuteActionContext,
 *     message: UserMessage,
 *     selection: AgentRuntimeSelection,
 *     resolvedBinding: ResolvedChatBinding,
 *     audioTranscriptionObserver?: {
 *       onAudioTranscriptionStart?: (event: { block: AudioContentBlock, modelId: string }) => void | Promise<void>,
 *       onAudioTranscriptionComplete?: (event: { block: AudioContentBlock, modelId: string, transcription: string }) => void | Promise<void>,
 *       onAudioTranscriptionFailure?: (event: { block: AudioContentBlock, modelId: string, error: unknown }) => void | Promise<void>,
 *     },
 *   }) => Promise<ChannelInput | null>,
 *   cancelActiveRun: (chatId: string, chatInfo: import("../store.js").ChatRow | undefined) => Promise<boolean>,
 *   clearActiveSession: (chatId: string, chatInfo: import("../store.js").ChatRow | undefined) => Promise<boolean>,
 *   resolveWorkdir: (input: { chatId: string, chatInfo: import("../store.js").ChatRow | undefined, chatName: string | null | undefined, selection: AgentRuntimeSelection, resolvedBinding: ResolvedChatBinding }) => string | undefined,
 *   handleCommand: (input: { selection: AgentRuntimeSelection, chatId: string, chatInfo: import("../store.js").ChatRow | undefined, context: ExecuteActionContext, command: string }) => Promise<boolean>,
 * }}
 */
export function createAgentRuntime({ store, llmClient, log }) {
  const {
    getMessages,
  } = store;
  const sessionPersistence = createAgentSessionPersistence(store);
  const runCoordinator = createHarnessRunCoordinator({
    liveInputJournal: {
      enqueue: store.enqueueHarnessLiveInput,
      markAccepted: store.deleteHarnessLiveInput,
    },
  });
  const sessionBinding = createHarnessSessionBindingService({
    directory: getHarnessSessionDirectory(),
    sessionPersistence,
    getMessages,
    llmClient,
    log,
    resolveHarnessInstanceForChat: async (chatInfo) => {
      const selection = await resolveSelection(chatInfo);
      return materializeRuntimeSelection(selection).harnessInstance;
    },
  });
  let runtimeTurnSequence = 0;

  /**
   * @param {import("../store.js").ChatRow | undefined} chatInfo
   * @returns {Promise<AgentRuntimeSelection>}
   */
  async function resolveSelection(chatInfo) {
    const persona = chatInfo?.active_persona
      ? await getAgent(chatInfo.active_persona)
      : null;
    const selectedRuntimeName = resolveHarnessName(persona, chatInfo);
    if (!selectedRuntimeName) {
      return {
        persona,
        selectedRuntimeName: null,
        runtimeName: null,
        instanceId: null,
        config: null,
        ownerKey: createRuntimeSelectionOwnerKey({
          selectedRuntimeName: null,
          runtimeName: null,
          instanceId: null,
          config: null,
        }),
      };
    }
    const { driver, instanceId, config: runtimeConfig, displayName } = getHarnessInstanceConfig(
      chatInfo?.harness_config,
      selectedRuntimeName,
    );
    const runtimeName = driver ?? selectedRuntimeName;
    return {
      persona,
      selectedRuntimeName,
      runtimeName,
      instanceId,
      config: runtimeConfig,
      ...(displayName ? { displayName } : {}),
      ownerKey: createRuntimeSelectionOwnerKey({
        selectedRuntimeName,
        runtimeName,
        instanceId,
        config: runtimeConfig,
        displayName,
      }),
    };
  }

  /**
   * @param {{
   *   chatId: string,
   *   harness: AgentHarness,
   *   harnessInstance: ReturnType<typeof resolveHarnessInstance>,
   *   hooks: AgentIOHooks,
   *   runConfig: HarnessRunConfig,
   *   turnInput: HarnessTurnInput,
   *   turnId: string,
   *   activeSessionBinding: Awaited<ReturnType<ReturnType<typeof createHarnessSessionBindingService>["beginTurn"]>>,
   * }} input
   * @returns {Promise<AgentResult>}
   */
  async function runProviderTurnWithRuntimeEvents({
    chatId,
    harness,
    harnessInstance,
    hooks,
    runConfig,
    turnInput,
    turnId,
    activeSessionBinding,
  }) {
    const adapter = harnessInstance.adapter;
    if (!adapter) {
      throw new Error(`Agent runtime instance "${harnessInstance.name}" does not have a semantic adapter.`);
    }
    const runtimeDispatcher = createHarnessRuntimeEventDispatcher({
      provider: harness.getName(),
      messages: turnInput.messages ?? [],
      hooks,
      emitRuntimeEvent: async (event) => {
        await hooks.onRuntimeEvent?.(event);
      },
      workdir: runConfig.workdir ?? null,
    });
    /** @type {Set<Promise<void>>} */
    const pendingEventHandlers = new Set();
    let eventChain = Promise.resolve();
    const unsubscribe = adapter.subscribeEvents?.((event) => {
      if (!isRuntimeEventForActiveProviderTurn(event, {
        chatId,
        turnId,
        providerInstanceId: harnessInstance.instanceId,
      })) {
        return;
      }
      /** @type {Promise<void>} */
      const pending = eventChain
        .then(() => runtimeDispatcher.handleEvent(/** @type {Parameters<typeof runtimeDispatcher.handleEvent>[0]} */ (event)))
        .catch((error) => {
          log.warn("Failed to handle agent runtime event:", error);
        });
      eventChain = pending.then(() => undefined, () => undefined);
      pendingEventHandlers.add(pending);
      pending.finally(() => {
        pendingEventHandlers.delete(pending);
      });
    });
    try {
      log.info("Agent runtime adapter sendTurn starting", {
        chatId,
        provider: harness.getName(),
        instanceId: harnessInstance.instanceId,
        turnId,
        resumeCursor: activeSessionBinding.getResumeCursor(),
      });
      const result = await adapter.sendTurn({
        ...turnInput,
        chatId,
        turnId,
        runConfig: turnInput.runConfig ?? runConfig,
        resumeCursor: activeSessionBinding.getResumeCursor(),
        hooks,
      });
      log.info("Agent runtime adapter sendTurn completed", {
        chatId,
        provider: harness.getName(),
        instanceId: harnessInstance.instanceId,
        turnId,
        responseBlocks: result.response.length,
      });
      await Promise.allSettled([...pendingEventHandlers]);
      await activeSessionBinding.syncFromAdapter(adapter, harness.getName());
      const runtimeUsage = runtimeDispatcher.result.usage;
      const hasRuntimeUsage = runtimeUsage.promptTokens > 0
        || runtimeUsage.completionTokens > 0
        || runtimeUsage.cachedTokens > 0
        || runtimeUsage.cost > 0;
      const mergedResponse = appendUniqueContentBlocks(runtimeDispatcher.result.response, result.response);
      return {
        ...result,
        response: mergedResponse,
        usage: hasRuntimeUsage ? runtimeUsage : result.usage,
      };
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * @param {{
   *   turn: ChannelInput,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   message: UserMessage,
   *   selection: AgentRuntimeSelection,
   *   resolvedBinding: ResolvedChatBinding,
   *   audioTranscriptionObserver?: {
   *     onAudioTranscriptionStart?: (event: { block: AudioContentBlock, modelId: string }) => void | Promise<void>,
   *     onAudioTranscriptionComplete?: (event: { block: AudioContentBlock, modelId: string, transcription: string }) => void | Promise<void>,
   *     onAudioTranscriptionFailure?: (event: { block: AudioContentBlock, modelId: string, error: unknown }) => void | Promise<void>,
   *   },
   * }} input
   * @returns {Promise<{ result: AgentResult, deliveredContentSignatures: Set<string> }>}
   */
  async function runResolvedRuntimeTurn({
    turn,
    chatInfo,
    context,
    message,
    selection,
    resolvedBinding,
    audioTranscriptionObserver,
  }) {
    const { persona, harness, harnessInstance } = materializeRuntimeSelection(selection);
    if (!harness) {
      throw new Error("No agent runtime is selected for this chat.");
    }
    const { chatId } = turn;
    const runtimeName = harness.getName();
    const runConfig = buildRunConfig(chatId, chatInfo, turn.chatName, runtimeName, resolvedBinding);
    const turnId = createRuntimeTurnId(chatId, ++runtimeTurnSequence);
    log.info("Agent runtime session begin starting", {
      chatId,
      runtimeName,
      instanceId: harnessInstance?.instanceId ?? null,
      turnId,
      workdir: runConfig.workdir ?? null,
    });
    const activeSessionBinding = await sessionBinding.beginTurn({
      chatId,
      chatInfo,
      harnessName: runtimeName,
      harnessInstance,
      runConfig,
      turnId,
    });
    log.info("Agent runtime session begin completed", {
      chatId,
      runtimeName,
      instanceId: harnessInstance?.instanceId ?? null,
      turnId,
      resumeCursor: activeSessionBinding.getResumeCursor(),
    });

    /** @type {Set<string>} */
    const deliveredContentSignatures = new Set();
    const hooks = buildAgentIoHooks(
      context,
      runConfig.workdir ?? null,
      resolveOutputVisibility(chatInfo?.output_visibility),
      (deliveredContent) => {
        addDeliveredContentSignatures(deliveredContentSignatures, deliveredContent);
      },
    );
    runCoordinator.markRunActive(chatId);
    activeSessionBinding.markRunning();

    const bufferedTexts = runCoordinator.consumeBufferedTexts(chatId);
    if (!harnessInstance?.adapter) {
      const messageText = harnessInstance?.status.message
        ?? `Agent runtime driver "${runtimeName}" is unavailable.`;
      return {
        result: {
          response: [{ type: "text", text: messageText }],
          messages: [message],
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        },
        deliveredContentSignatures,
      };
    }
    log.info("Agent runtime turn input build starting", {
      chatId,
      runtimeName,
      turnId,
      bufferedTextCount: bufferedTexts.length,
    });
    const turnInput = await buildHarnessTurnInput({
      chatId,
      chatInfo,
      context,
      message,
      persona,
      llmClient,
      getMessages,
      harnessName: runtimeName,
      runConfig,
      bufferedTexts,
      audioTranscriptionObserver,
    });
    log.info("Agent runtime turn input build completed", {
      chatId,
      runtimeName,
      turnId,
      inputLength: turnInput.input?.length ?? 0,
      messageCount: turnInput.messages?.length ?? 0,
      attachmentCount: turnInput.attachments?.length ?? 0,
    });
    const result = await runProviderTurnWithRuntimeEvents({
      chatId,
      harness,
      harnessInstance,
      hooks,
      runConfig,
      turnInput,
      turnId,
      activeSessionBinding,
    });
    activeSessionBinding.markReady();

    return { result, deliveredContentSignatures };
  }

  return {
    resolveSelection,

    hasSelectedRuntime(selection) {
      return !!selection.runtimeName;
    },

    hasPendingRun(chatId) {
      return runCoordinator.hasPendingRun(chatId);
    },

    beginRun({ turn, userText, selection, allowLiveInputTarget = true }) {
      const liveInputTarget = runCoordinator.hasPendingRun(turn.chatId)
        ? undefined
        : allowLiveInputTarget
          ? resolveProviderLiveInputTarget(materializeRuntimeSelection(selection).harnessInstance)
          : NO_LIVE_INPUT_TARGET;
      return runCoordinator.beginRun({
        turn,
        userText,
        liveInputTarget,
        ownerKey: selection.ownerKey,
      });
    },

    preparePendingLiveInputReplay(chatId, turn) {
      return runCoordinator.preparePendingLiveInputReplay(chatId, turn);
    },

    async interruptTurn(selection, chatId) {
      const { harnessInstance } = materializeRuntimeSelection(selection);
      return !!(await harnessInstance?.adapter?.interruptTurn({ chatId }));
    },

    finishRun(chatId) {
      return runCoordinator.finishRun(chatId);
    },

    async runStartedTurn({
      turn,
      chatInfo,
      context,
      message,
      selection,
      resolvedBinding,
      audioTranscriptionObserver,
    }) {
      const { chatId } = turn;
      const agentOutput = createAgentRunOutputPort(context);
      /** @type {ChannelInput | null} */
      let nextTurn = null;
      try {
        const { result, deliveredContentSignatures } = await runResolvedRuntimeTurn({
          turn,
          chatInfo,
          context,
          message,
          selection,
          resolvedBinding,
          audioTranscriptionObserver,
        });
        if (result.response.length > 0) {
          const responseSignature = getDeliveredContentSignature(result.response);
          if (!deliveredContentSignatures.has(responseSignature)) {
            const undeliveredResponse = filterUndeliveredContentBlocks(result.response, deliveredContentSignatures);
            if (undeliveredResponse.length > 0) {
              await agentOutput.replyWithAssistantOutput(undeliveredResponse);
            }
          }
        }
        log.info("Agent runtime run completed", {
          chatId,
          responseBlocks: result.response.length,
          deliveredSignatures: deliveredContentSignatures.size,
        });
      } catch (error) {
        sessionBinding.markError(chatId);
        log.error("Agent runtime run failed:", error);
        const errorMessage = errorToString(error);
        try {
          await agentOutput.replyWithError(errorMessage);
        } catch {
          // best effort
        }
      } finally {
        nextTurn = runCoordinator.finishRun(chatId);
        log.info("Agent runtime run finalized", {
          chatId,
          replayNextTurn: nextTurn !== null,
          nextTurnContentTypes: nextTurn ? summarizeContentTypes(nextTurn.content) : null,
        });
      }

      return nextTurn;
    },

    async cancelActiveRun(chatId, chatInfo) {
      const selection = await resolveSelection(chatInfo);
      const { harness } = materializeRuntimeSelection(selection);
      return !!(await harness?.cancel?.(chatId));
    },

    clearActiveSession: sessionBinding.clearActiveSession,

    resolveWorkdir({ chatId, chatInfo, chatName, selection, resolvedBinding }) {
      return buildRunConfig(chatId, chatInfo, chatName, selection.runtimeName, resolvedBinding).workdir ?? undefined;
    },

    async handleCommand({ selection, chatId, chatInfo, context, command }) {
      const { harness } = materializeRuntimeSelection(selection);
      if (!harness) {
        return false;
      }
      /** @type {HarnessCommandContext} */
      const commandInput = {
        chatId,
        chatInfo,
        context,
        command,
        sessionControl: sessionBinding.createCommandSessionControl(chatInfo),
        sessionForkControl: sessionBinding.createSessionForkControl(),
      };
      return harness.handleCommand(commandInput);
    },
  };
}
