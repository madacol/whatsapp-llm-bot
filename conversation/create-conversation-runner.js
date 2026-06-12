import { formatChatSettingsCommand } from "../chat-commands.js";
import { getAgent } from "../agents.js";
import {
  createHarnessRuntimeEventDispatcher,
  resolveHarnessInstance,
  resolveHarnessName,
  createHarnessRunCoordinator,
  getHarnessSessionDirectory,
} from "#harnesses";
import { getHarnessInstanceConfig } from "../harness-config.js";
import { contentEvent } from "../outbound-events.js";
import { shouldRespond } from "../message-formatting.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { errorToString } from "../utils.js";
import { createLogger } from "../logger.js";
import { appendUniqueContentBlocks, getDeliveredContentSignature } from "../content-signature.js";
import { buildAgentIoHooks } from "./build-agent-io-hooks.js";
import { buildHarnessTurnInput } from "./build-harness-turn-input.js";
import { buildRunConfig } from "./build-run-config.js";
import { getChatDb } from "../db.js";
import { resolveOutputVisibility } from "../chat-output-visibility.js";
import { createWorkspaceBindingService } from "../workspace-binding-service.js";
import { createWorkspaceControl } from "../workspace-control.js";
import { createWorkspaceLifecycleService } from "../workspace-lifecycle-service.js";
import { buildLiveInputText } from "./live-input-text.js";
import { defaultRestartGate } from "../restart-gate.js";
import { createBangCommandRouter } from "../commands/bang-command-router.js";
import { runClearConversationCommand } from "../commands/clear-conversation-command.js";
import { handleSlashDiffCommand } from "../slash-diff-command.js";
import { decideTurnRoute } from "./turn-routing.js";
import { createHarnessSessionBindingService } from "./harness-session-binding.js";

const log = createLogger("conversation:runner");
const NO_LIVE_INPUT_TARGET = Object.freeze({ supportsLiveInput: false });
const DEFAULT_LIVE_INPUT_FALLBACK_DELAY_MS = 1500;
/**
 * Type guard: checks that a content block is a text block.
 * @param {IncomingContentBlock} block
 * @returns {block is TextContentBlock}
 */
function isTextBlock(block) {
  return block.type === "text";
}

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
function getHarnessRuntimeEventChatId(event) {
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
function isHarnessRuntimeEventForChat(event, chatId) {
  const eventChatId = getHarnessRuntimeEventChatId(event);
  return eventChatId === null || eventChatId === chatId;
}

/**
 * @param {IncomingContentBlock[]} content
 * @returns {boolean}
 */
function hasNonTextContent(content) {
  return content.some((block) => block.type !== "text");
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
 * @param {{ image?: string, audio?: string, video?: string, general?: string } | undefined} models
 * @returns {string}
 */
function summarizeConfiguredMediaModels(models) {
  return Object.entries(models ?? {})
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key]) => key)
    .join(",");
}

/**
 * @param {string[]} transcriptions
 * @returns {string}
 */
function formatAudioTranscriptionInspectText(transcriptions) {
  if (transcriptions.length === 1) {
    return transcriptions[0];
  }
  return transcriptions
    .map((text, index) => `Audio ${index + 1}:\n${text}`)
    .join("\n\n");
}

/**
 * @param {ExecuteActionContext} context
 * @returns {{
 *   onAudioTranscriptionStart: (event: { block: AudioContentBlock, modelId: string }) => Promise<void>,
 *   onAudioTranscriptionComplete: (event: { block: AudioContentBlock, modelId: string, transcription: string }) => Promise<void>,
 *   onAudioTranscriptionFailure: (event: { block: AudioContentBlock, modelId: string, error: unknown }) => Promise<void>,
 * }}
 */
function createAudioTranscriptionStatusObserver(context) {
  /** @type {Promise<MessageHandle | undefined> | null} */
  let handlePromise = null;
  /** @type {string[]} */
  const transcriptions = [];

  /**
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function ensureHandle() {
    if (!handlePromise) {
      handlePromise = context.reply(contentEvent("plain", "Transcribing audio...", {
        replyToTriggeringMessage: true,
      }));
    }
    return handlePromise;
  }

  return {
    onAudioTranscriptionStart: async () => {
      await ensureHandle();
    },
    onAudioTranscriptionComplete: async ({ transcription }) => {
      const isNewTranscription = !transcriptions.includes(transcription);
      if (isNewTranscription) {
        transcriptions.push(transcription);
      }
      const handle = await ensureHandle();
      handle?.setInspect({
        kind: "text",
        text: formatAudioTranscriptionInspectText(transcriptions),
        persistOnInspect: true,
      });
      if (!isNewTranscription) {
        return;
      }
      await handle?.update({
        kind: "text",
        text: "Transcribed",
      });
    },
    onAudioTranscriptionFailure: async () => {
      const handle = await ensureHandle();
      await handle?.update({ kind: "text", text: "Audio transcription failed." });
    },
  };
}

/**
 * @param {boolean} visible
 * @param {string} message
 * @param {unknown} details
 * @returns {void}
 */
function logInfoWhen(visible, message, details) {
  if (visible) {
    log.info(message, details);
  } else {
    log.debug(message, details);
  }
}

/**
 * @param {IncomingContentBlock[]} content
 * @returns {string}
 */
function getTopLevelText(content) {
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
}

/**
 * @param {ChatTurn} turn
 * @returns {UserMessage}
 */
function buildUserMessage(turn) {
  return {
    role: "user",
    content: turn.content,
    ...(turn.facts.isGroup && turn.senderName ? { senderName: turn.senderName } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableHarnessSelectionValue(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableHarnessSelectionValue).join(",")}]`;
  }
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableHarnessSelectionValue(entry)}`).join(",")}}`;
}

/**
 * @param {{
 *   selectedHarnessName: string | null,
 *   harnessName: string | null,
 *   instanceId: string | null,
 *   config: Record<string, unknown> | null,
 *   displayName?: string,
 * }} selection
 * @returns {string}
 */
function createHarnessSelectionOwnerKey(selection) {
  return stableHarnessSelectionValue({
    selectedHarnessName: selection.selectedHarnessName,
    harnessName: selection.harnessName,
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
function createHarnessRuntimeTurnId(chatId, sequence) {
  return `${chatId}:${Date.now()}:${sequence}`;
}

/**
 * @param {{ type: string } & Record<string, unknown>} event
 * @param {{ chatId: string, turnId: string, providerInstanceId: string }} activeTurn
 * @returns {boolean}
 */
function isHarnessRuntimeEventForActiveProviderTurn(event, activeTurn) {
  if (!isHarnessRuntimeEventForChat(event, activeTurn.chatId)) {
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
 * @param {string} text
 * @param {"!" | "/"} prefix
 * @returns {{ prompt: string } | null}
 */
function parseClearCommandText(text, prefix) {
  const escapedPrefix = prefix === "/" ? "\\/" : "!";
  const match = text.match(new RegExp(`^${escapedPrefix}clear(?:\\s+([\\s\\S]*))?$`, "i"));
  if (!match) {
    return null;
  }
  return { prompt: match[1]?.trim() ?? "" };
}

/**
 * @param {ChatTurn} turn
 * @param {TextContentBlock} firstBlock
 * @param {"!" | "/"} prefix
 * @returns {{ followUpTurn: ChatTurn | null } | null}
 */
function buildClearCommandFollowUp(turn, firstBlock, prefix) {
  const parsed = parseClearCommandText(firstBlock.text, prefix);
  if (!parsed) {
    return null;
  }
  const firstTextIndex = turn.content.indexOf(firstBlock);
  if (firstTextIndex === -1) {
    return { followUpTurn: null };
  }
  /** @type {IncomingContentBlock[]} */
  const followUpContent = [];
  for (let index = 0; index < turn.content.length; index += 1) {
    const block = turn.content[index];
    if (index === firstTextIndex) {
      if (parsed.prompt) {
        followUpContent.push({ type: "text", text: parsed.prompt });
      }
      continue;
    }
    followUpContent.push(block);
  }
  if (followUpContent.length === 0) {
    return { followUpTurn: null };
  }
  return {
    followUpTurn: {
      ...turn,
      content: followUpContent,
      facts: {
        ...turn.facts,
        addressedToBot: true,
      },
    },
  };
}

/**
 * Resolve the persona and selected harness config without constructing the
 * provider instance. This lets pending turns compare owner identity without
 * disposing the still-active instance for a newly selected config.
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @returns {Promise<{
 *   persona: AgentDefinition | null,
 *   selectedHarnessName: string | null,
 *   harnessName: string | null,
 *   instanceId: string | null,
 *   config: Record<string, unknown> | null,
 *   displayName?: string,
 *   ownerKey: string,
 * }>}
 */
async function resolveConversationHarnessSelection(chatInfo) {
  const persona = chatInfo?.active_persona
    ? await getAgent(chatInfo.active_persona)
    : null;
  const selectedHarnessName = resolveHarnessName(persona, chatInfo);
  if (!selectedHarnessName) {
    return {
      persona,
      selectedHarnessName: null,
      harnessName: null,
      instanceId: null,
      config: null,
      ownerKey: createHarnessSelectionOwnerKey({
        selectedHarnessName: null,
        harnessName: null,
        instanceId: null,
        config: null,
      }),
    };
  }
  const { driver, instanceId, config: harnessConfig, displayName } = getHarnessInstanceConfig(
    chatInfo?.harness_config,
    selectedHarnessName,
  );
  const harnessName = driver ?? selectedHarnessName;
  return {
    persona,
    selectedHarnessName,
    harnessName,
    instanceId,
    config: harnessConfig,
    ...(displayName ? { displayName } : {}),
    ownerKey: createHarnessSelectionOwnerKey({
      selectedHarnessName,
      harnessName,
      instanceId,
      config: harnessConfig,
      displayName,
    }),
  };
}

/**
 * @param {Awaited<ReturnType<typeof resolveConversationHarnessSelection>>} selection
 * @returns {{ persona: AgentDefinition | null, harness: AgentHarness | null, harnessInstance: ReturnType<typeof resolveHarnessInstance> | null }}
 */
function resolveConversationHarnessFromSelection(selection) {
  if (!selection.harnessName) {
    return {
      persona: selection.persona,
      harness: null,
      harnessInstance: null,
    };
  }
  const harnessInstance = resolveHarnessInstance(selection.harnessName, {
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
 * Pick the live-input surface for a run. Semantic adapters own provider-native
 * turn state, so provider live input must inject through the adapter.
 * @param {ReturnType<typeof resolveHarnessInstance> | null} harnessInstance
 * @returns {{ supportsLiveInput: boolean, injectMessage?: AgentHarness["injectMessage"] }}
 */
function resolveProviderLiveInputTarget(harnessInstance) {
  if (!harnessInstance?.adapter || !harnessInstance.capabilities.supportsLiveInput) {
    return NO_LIVE_INPUT_TARGET;
  }
  return {
    supportsLiveInput: true,
    injectMessage: harnessInstance.adapter.injectMessage.bind(harnessInstance.adapter),
  };
}

/**
 * @typedef {import("../store.js").Store} Store
 *
 * @typedef {{
 *   store: Store,
 *   llmClient: LlmClient,
 *   restartCommandHandler?: ReturnType<typeof import("../commands/restart-command.js").createRestartCommandHandler>,
 *   transport?: ChatTransport,
 *   workspacePresentation?: WorkspacePresentationPort,
 *   restartGate?: import("../restart-gate.js").RestartGate,
 *   liveInputFallbackDelayMs?: number,
 * }} ConversationRunnerDeps
 */

/**
 * Create the conversation runner that owns command dispatch and harness orchestration.
 * @param {ConversationRunnerDeps} deps
 * @returns {{ handleMessage: (turn: ChatTurn) => Promise<void> }}
 */
export function createConversationRunner({
  store,
  llmClient,
  restartCommandHandler,
  workspacePresentation,
  restartGate = defaultRestartGate,
  liveInputFallbackDelayMs = DEFAULT_LIVE_INPUT_FALLBACK_DELAY_MS,
}) {
  const {
    addMessage,
    createChat,
    getChat,
    getMessages,
    saveHarnessSession,
    archiveHarnessSession,
    getHarnessSessionHistory,
    restoreHarnessSession,
    pushHarnessForkStack,
    popHarnessForkStack,
  } = store;

  const runCoordinator = createHarnessRunCoordinator();
  const harnessSessionDirectory = getHarnessSessionDirectory();
  const workspaceBinding = createWorkspaceBindingService(store);
  const workspaceControl = createWorkspaceControl({ store, workspacePresentation });
  const workspaceLifecycle = createWorkspaceLifecycleService({
    workspaceControl,
    workspacePresentation,
    dispatchTurn,
  });
  const sessionBinding = createHarnessSessionBindingService({
    directory: harnessSessionDirectory,
    saveHarnessSession,
    archiveHarnessSession,
    getHarnessSessionHistory,
    restoreHarnessSession,
    pushHarnessForkStack,
    popHarnessForkStack,
    getMessages,
    llmClient,
    log,
    resolveHarnessInstanceForChat: async (chatInfo) => {
      const selection = await resolveConversationHarnessSelection(chatInfo);
      return resolveConversationHarnessFromSelection(selection).harnessInstance;
    },
  });

  const bangCommandRouter = createBangCommandRouter({
    workspaceControl: workspaceLifecycle,
    addMessage,
    restartCommandHandler,
    cancelActiveRun: async (chatId, chatInfo) => {
      const selection = await resolveConversationHarnessSelection(chatInfo);
      const { harness } = resolveConversationHarnessFromSelection(selection);
      return !!(await harness?.cancel?.(chatId));
    },
    clearActiveSession: sessionBinding.clearActiveSession,
  });
  let harnessRuntimeTurnSequence = 0;

  /**
   * Build the text passed into a live harness turn. Idle first turns avoid this
   * path so media transcription does not delay marking a new run as pending.
   * @param {{
   *   chatId: string,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   content: IncomingContentBlock[],
   *   audioTranscriptionObserver?: ReturnType<typeof createAudioTranscriptionStatusObserver>,
   * }} input
   * @returns {Promise<string>}
   */
  async function buildPendingRunInputText({ chatId, chatInfo, content, audioTranscriptionObserver }) {
    if (!hasNonTextContent(content)) {
      return getTopLevelText(content);
    }

    const text = await buildLiveInputText({
      content,
      llmClient,
      mediaToTextModels: chatInfo?.media_to_text_models ?? {},
      db: getChatDb(chatId),
      onAudioTranscriptionStart: audioTranscriptionObserver?.onAudioTranscriptionStart,
      onAudioTranscriptionComplete: audioTranscriptionObserver?.onAudioTranscriptionComplete,
      onAudioTranscriptionFailure: audioTranscriptionObserver?.onAudioTranscriptionFailure,
    });
    log.info("Built pending live input text", {
      chatId,
      contentTypes: summarizeContentTypes(content),
      mediaModelKeys: summarizeConfiguredMediaModels(chatInfo?.media_to_text_models),
      textLength: text.length,
    });
    return text;
  }

  /**
   * @param {ChatTurn} turn
   * @returns {Promise<void>}
   */
  async function dispatchTurn(turn) {
    /** @type {ChatTurn | null} */
    let nextTurn = turn;
    while (nextTurn) {
      nextTurn = await handleSingleMessage(nextTurn);
    }
  }

  /**
   * Replay a live-input message as a normal turn if provider steering stays
   * unavailable after the active query already rejected it.
   * @param {ChatTurn} turn
   * @param {() => Promise<void>} interruptActiveTurn
   * @returns {void}
   */
  function scheduleLiveInputReplay(turn, interruptActiveTurn) {
    const timer = setTimeout(() => {
      const replay = runCoordinator.preparePendingLiveInputReplay(turn.chatId, turn);
      if (!replay) {
        return;
      }
      void (async () => {
        await interruptActiveTurn();
        log.warn("Prepared buffered live input for replay after active run finalizes", {
          chatId: turn.chatId,
          textLength: replay.text.length,
          originalContentTypes: summarizeContentTypes(replay.turn.content),
        });
      })().catch((error) => {
        log.error("Failed to replay buffered live input:", error);
      });
    }, liveInputFallbackDelayMs);
    timer.unref?.();
  }

  /**
   * Handle a `!command` message.
   * @param {{
   *   turn: ChatTurn,
   *   chatId: string,
   *   senderIds: string[],
   *   content: IncomingContentBlock[],
   *   firstBlock: TextContentBlock,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   resolvedBinding: ResolvedChatBinding,
   * }} input
   * @returns {Promise<ChatTurn | null>}
   */
  async function handleCommandMessage({ turn, chatId, senderIds, content, firstBlock, chatInfo, context, resolvedBinding }) {
    const clearFollowUp = buildClearCommandFollowUp(turn, firstBlock, "!");
    await bangCommandRouter({ turn, chatId, senderIds, content, firstBlock, chatInfo, context, resolvedBinding });
    return clearFollowUp?.followUpTurn ?? null;
  }

  /**
   * Run a semantic provider turn through the selected adapter. Provider adapters
   * emit runtime events separately, so those events are merged back into the
   * returned result when they produced user-visible text.
   * @param {{
   *   chatId: string,
   *   harness: AgentHarness,
   *   harnessInstance: ReturnType<typeof resolveHarnessInstance>,
   *   hooks: AgentIOHooks,
   *   runConfig: HarnessRunConfig,
   *   turnInput: HarnessTurnInput,
   *   turnId: string,
   *   sessionBinding: Awaited<ReturnType<ReturnType<typeof createHarnessSessionBindingService>["beginTurn"]>>,
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
    sessionBinding,
  }) {
    const adapter = harnessInstance.adapter;
    if (!adapter) {
      throw new Error(`Harness instance "${harnessInstance.name}" does not have a semantic adapter.`);
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
      if (!isHarnessRuntimeEventForActiveProviderTurn(event, {
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
          log.warn("Failed to handle harness runtime event:", error);
        });
      eventChain = pending.then(() => undefined, () => undefined);
      pendingEventHandlers.add(pending);
      pending.finally(() => {
        pendingEventHandlers.delete(pending);
      });
    });
    try {
      log.info("Provider adapter sendTurn starting", {
        chatId,
        provider: harness.getName(),
        instanceId: harnessInstance.instanceId,
        turnId,
        resumeCursor: sessionBinding.getResumeCursor(),
      });
      const result = await adapter.sendTurn({
        ...turnInput,
        chatId,
        turnId,
        runConfig: turnInput.runConfig ?? runConfig,
        resumeCursor: sessionBinding.getResumeCursor(),
        hooks,
      });
      log.info("Provider adapter sendTurn completed", {
        chatId,
        provider: harness.getName(),
        instanceId: harnessInstance.instanceId,
        turnId,
        responseBlocks: result.response.length,
      });
      await Promise.allSettled([...pendingEventHandlers]);
      await sessionBinding.syncFromAdapter(adapter, harness.getName());
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
   * Execute the selected ACP provider for one chat turn.
   * @param {{
   *   turn: ChatTurn,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   message: UserMessage,
   *   persona: AgentDefinition | null,
   *   harness: AgentHarness,
   *   harnessInstance: ReturnType<typeof resolveHarnessInstance> | null,
   *   resolvedBinding: ResolvedChatBinding,
   *   audioTranscriptionObserver?: ReturnType<typeof createAudioTranscriptionStatusObserver>,
   * }} input
   * @returns {Promise<{ result: AgentResult, deliveredContentSignatures: Set<string> }>}
   */
  async function runResolvedHarnessTurn({
    turn,
    chatInfo,
    context,
    message,
    persona,
    harness,
    harnessInstance,
    resolvedBinding,
    audioTranscriptionObserver,
  }) {
    const { chatId } = turn;
    const harnessName = harness.getName();
    const runConfig = buildRunConfig(chatId, chatInfo, turn.chatName, harnessName, resolvedBinding);
    const turnId = createHarnessRuntimeTurnId(chatId, ++harnessRuntimeTurnSequence);
    log.info("Harness session begin starting", {
      chatId,
      harnessName,
      instanceId: harnessInstance?.instanceId ?? null,
      turnId,
      workdir: runConfig.workdir ?? null,
    });
    const activeSessionBinding = await sessionBinding.beginTurn({
      chatId,
      chatInfo,
      harnessName,
      harnessInstance,
      runConfig,
      turnId,
    });
    log.info("Harness session begin completed", {
      chatId,
      harnessName,
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
        ?? `Harness driver "${harnessName}" is unavailable.`;
      return {
        result: {
          response: [{ type: "text", text: messageText }],
          messages: [message],
          usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 },
        },
        deliveredContentSignatures,
      };
    }
    log.info("Harness turn input build starting", {
      chatId,
      harnessName,
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
      harnessName,
      runConfig,
      bufferedTexts,
      audioTranscriptionObserver,
    });
    log.info("Harness turn input build completed", {
      chatId,
      harnessName,
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
      sessionBinding: activeSessionBinding,
    });
    activeSessionBinding.markReady();

    return { result, deliveredContentSignatures };
  }

  /**
   * Handle a regular (non-command) message by delegating to the selected harness.
   * @param {{
   *   turn: ChatTurn,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   persona: AgentDefinition | null,
   *   harness: AgentHarness | null,
   *   harnessInstance: ReturnType<typeof resolveHarnessInstance> | null,
   *   harnessOwnerKey: string,
   *   resolvedBinding: ResolvedChatBinding,
   *   audioTranscriptionObserver?: ReturnType<typeof createAudioTranscriptionStatusObserver>,
   * }} input
   * @returns {Promise<ChatTurn | null>}
   */
  async function handleLlmMessage({
    turn,
    chatInfo,
    context,
    persona,
    harness,
    harnessInstance,
    harnessOwnerKey,
    resolvedBinding,
    audioTranscriptionObserver = createAudioTranscriptionStatusObserver(context),
  }) {
    const { chatId, senderIds, content } = turn;
    const message = buildUserMessage(turn);
    await addMessage(chatId, message, senderIds);

    logInfoWhen(hasNonTextContent(content) || runCoordinator.hasPendingRun(chatId), "LLM will respond", {
      chatId,
      contentTypes: summarizeContentTypes(content),
      hasPendingRun: runCoordinator.hasPendingRun(chatId),
    });

    if (!harness) {
      await context.reply(contentEvent(
        "error",
        "No ACP harness is selected for this chat and the central default is disabled. Set one with `!s harness codex`.",
      ));
      return null;
    }

    const userText = runCoordinator.hasPendingRun(chatId)
      ? await buildPendingRunInputText({ chatId, chatInfo, content, audioTranscriptionObserver })
      : getTopLevelText(content);
    const lifecycleDecision = await runCoordinator.beginRun({
      turn,
      userText,
      liveInputTarget: resolveProviderLiveInputTarget(harnessInstance),
      ownerKey: harnessOwnerKey,
    });
    logInfoWhen(hasNonTextContent(content) || lifecycleDecision.status !== "started", "Harness run lifecycle decision", {
      chatId,
      status: lifecycleDecision.status,
      reason: lifecycleDecision.reason ?? null,
      userTextLength: userText.length,
      contentTypes: summarizeContentTypes(content),
    });
    if (lifecycleDecision.status === "buffered") {
      log.debug("Buffered message for pending harness run on chat", chatId);
      return null;
    }
    if (lifecycleDecision.status === "injected") {
      log.debug("Injected message into active harness query for chat", chatId);
      return null;
    }

    return runStartedLlmMessage({
      turn,
      chatInfo,
      context,
      message,
      persona,
      harness,
      harnessInstance,
      resolvedBinding,
      audioTranscriptionObserver,
    });
  }

  /**
   * Run a chat turn after `runCoordinator.beginRun` has returned "started".
   * @param {{
   *   turn: ChatTurn,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   message: UserMessage,
   *   persona: AgentDefinition | null,
   *   harness: AgentHarness,
   *   harnessInstance: ReturnType<typeof resolveHarnessInstance> | null,
   *   resolvedBinding: ResolvedChatBinding,
   *   audioTranscriptionObserver?: ReturnType<typeof createAudioTranscriptionStatusObserver>,
   * }} input
   * @returns {Promise<ChatTurn | null>}
   */
  async function runStartedLlmMessage({
    turn,
    chatInfo,
    context,
    message,
    persona,
    harness,
    harnessInstance,
    resolvedBinding,
    audioTranscriptionObserver,
  }) {
    const { chatId } = turn;
    /** @type {ChatTurn | null} */
    let nextTurn = null;
    try {
      const { result, deliveredContentSignatures } = await runResolvedHarnessTurn({
        turn,
        chatInfo,
        context,
        message,
        persona,
        harness,
        harnessInstance,
        resolvedBinding,
        audioTranscriptionObserver,
      });
      if (result.response.length > 0) {
        const responseSignature = getDeliveredContentSignature(result.response);
        if (!deliveredContentSignatures.has(responseSignature)) {
          const undeliveredResponse = filterUndeliveredContentBlocks(result.response, deliveredContentSignatures);
          if (undeliveredResponse.length > 0) {
            await context.reply(contentEvent("llm", undeliveredResponse));
          }
        }
      }
      logInfoWhen(hasNonTextContent(turn.content) || result.response.length === 0, "Harness run completed", {
        chatId,
        responseBlocks: result.response.length,
        deliveredSignatures: deliveredContentSignatures.size,
      });
    } catch (error) {
      sessionBinding.markError(chatId);
      log.error("handleLlmMessage failed:", error);
      const errorMessage = errorToString(error);
      try {
        await context.reply(contentEvent("error", errorMessage));
      } catch {
        // best effort
      }
    } finally {
      nextTurn = runCoordinator.finishRun(chatId);
      logInfoWhen(hasNonTextContent(turn.content) || nextTurn !== null, "Harness run finalized", {
        chatId,
        replayNextTurn: nextTurn !== null,
        nextTurnContentTypes: nextTurn ? summarizeContentTypes(nextTurn.content) : null,
      });
    }

    return nextTurn;
  }

  /**
   * Handle one normalized chat turn from the transport.
   * @param {ChatTurn} turn
   * @returns {Promise<ChatTurn | null>}
   */
  async function handleSingleMessage(turn) {
    const { chatId, senderIds, content } = turn;

    log.debug("INCOMING MESSAGE:", JSON.stringify(turn, null, 2));

    await createChat(chatId);

    const chatInfo = await getChat(chatId);
    const context = createMessageActionContext(turn);
    const resolvedBinding = await workspaceBinding.resolveChatBinding(
      chatId,
      chatInfo?.harness_cwd,
      turn.chatName,
      turn.facts.isGroup,
    );
    const firstBlock = content.find(isTextBlock);
    const route = decideTurnRoute({
      chatInfo,
      resolvedBinding,
      firstText: firstBlock?.text ?? null,
      hasPendingRun: runCoordinator.hasPendingRun(chatId),
      shouldRespond: shouldRespond(chatInfo, turn.facts),
    });
    const routeShouldLogInfo = hasNonTextContent(content)
      || runCoordinator.hasPendingRun(chatId)
      || route.type !== "harness-run";
    logInfoWhen(routeShouldLogInfo, "Turn route decision", {
      chatId,
      route: route.type,
      shouldRespond: "shouldRespond" in route ? route.shouldRespond : shouldRespond(chatInfo, turn.facts),
      hasPendingRun: runCoordinator.hasPendingRun(chatId),
      contentTypes: summarizeContentTypes(content),
      firstTextLength: firstBlock?.text.length ?? 0,
      addressedToBot: turn.facts.addressedToBot,
      repliedToBot: turn.facts.repliedToBot,
    });

    if (route.type === "archived-workspace-error") {
      await context.reply(contentEvent(
        "error",
        "This workspace is archived and no longer accepts work.",
      ));
      return null;
    }

    if (route.type === "bang-command" && firstBlock) {
      return handleCommandMessage({
        turn,
        chatId,
        senderIds,
        content,
        firstBlock,
        chatInfo,
        context,
        resolvedBinding,
      });
    }

    if (route.type === "pending-followup") {
      if (!route.shouldRespond) {
        await addMessage(chatId, buildUserMessage(turn), senderIds);
        return null;
      }
      const harnessSelection = await resolveConversationHarnessSelection(chatInfo);
      const audioTranscriptionObserver = createAudioTranscriptionStatusObserver(context);
      const userText = await buildPendingRunInputText({
        chatId,
        chatInfo,
        content,
        audioTranscriptionObserver,
      });
      if (!runCoordinator.hasPendingRun(chatId)) {
        const { persona, harness, harnessInstance } = resolveConversationHarnessFromSelection(harnessSelection);
        return handleLlmMessage({
          turn,
          chatInfo,
          context,
          persona,
          harness,
          harnessInstance,
          harnessOwnerKey: harnessSelection.ownerKey,
          resolvedBinding,
          audioTranscriptionObserver,
        });
      }
      const lifecycleDecision = await runCoordinator.beginRun({
        turn,
        userText,
        liveInputTarget: NO_LIVE_INPUT_TARGET,
        ownerKey: harnessSelection.ownerKey,
      });
      log.info("Pending follow-up lifecycle decision", {
        chatId,
        status: lifecycleDecision.status,
        reason: lifecycleDecision.reason ?? null,
        userTextLength: userText.length,
        contentTypes: summarizeContentTypes(content),
      });
      if (lifecycleDecision.status === "buffered") {
        await addMessage(chatId, buildUserMessage(turn), senderIds);
        log.debug("Buffered message for pending harness run on chat", chatId);
        if (lifecycleDecision.reason === "live-input-retry") {
          scheduleLiveInputReplay(turn, async () => {
            const { harnessInstance } = resolveConversationHarnessFromSelection(harnessSelection);
            await harnessInstance?.adapter?.interruptTurn({ chatId });
          });
        }
      } else if (lifecycleDecision.status === "injected") {
        await addMessage(chatId, buildUserMessage(turn), senderIds);
        log.debug("Injected message into active harness query for chat", chatId);
      } else if (lifecycleDecision.status === "started") {
        const { persona, harness, harnessInstance } = resolveConversationHarnessFromSelection(harnessSelection);
        const message = buildUserMessage(turn);
        await addMessage(chatId, message, senderIds);
        if (!harness) {
          await context.reply(contentEvent(
            "error",
            "No ACP harness is selected for this chat and the central default is disabled. Set one with `!s harness codex`.",
          ));
          runCoordinator.finishRun(chatId);
          return null;
        }
        return runStartedLlmMessage({
          turn,
          chatInfo,
          context,
          message,
          persona,
          harness,
          harnessInstance,
          resolvedBinding,
          audioTranscriptionObserver,
        });
      }
      return null;
    }

    if (route.type === "persist-only") {
      await addMessage(chatId, buildUserMessage(turn), senderIds);
      return null;
    }

    if (route.type === "disabled-slash-command") {
      await context.reply(contentEvent("error", `Bot is not enabled in this chat. Use ${formatChatSettingsCommand("enabled on")}`));
      return null;
    }

    const harnessSelection = await resolveConversationHarnessSelection(chatInfo);
    const { persona, harness, harnessInstance } = resolveConversationHarnessFromSelection(harnessSelection);

    if (route.type === "slash-command" && firstBlock) {
      const clearFollowUp = buildClearCommandFollowUp(turn, firstBlock, "/");
      const slashCommand = clearFollowUp
        ? "clear"
        : firstBlock.text.slice(1).trim().toLowerCase();
      if (slashCommand === "diff") {
        const slashWorkdir = buildRunConfig(chatId, chatInfo, turn.chatName, harnessSelection.harnessName, resolvedBinding).workdir;
        if (!slashWorkdir) {
          await context.reply(contentEvent("error", "Could not resolve a workdir for `/diff`."));
          return null;
        }
        const handledSlashDiff = await handleSlashDiffCommand({
          command: slashCommand,
          workdir: slashWorkdir,
          context,
        });
        if (handledSlashDiff) {
          return null;
        }
      }
      /** @type {HarnessCommandContext} */
      const commandInput = {
        chatId,
        chatInfo,
        context,
        command: slashCommand,
        sessionControl: sessionBinding.createCommandSessionControl(chatInfo),
        sessionForkControl: sessionBinding.createSessionForkControl(),
      };
      const handled = harness
        ? await harness.handleCommand(commandInput)
        : false;
      if (handled) {
        if (clearFollowUp) {
          await runClearConversationCommand(context);
        }
        return clearFollowUp?.followUpTurn ?? null;
      }

      if (clearFollowUp) {
        await sessionBinding.clearActiveSession(chatId, chatInfo);
        const result = await runClearConversationCommand(context);
        if (result !== "Conversation history cleared.") {
          await context.reply(contentEvent("tool-result", result));
          return null;
        }
        await context.reply(contentEvent("tool-result", "Session cleared\n\nNext message starts fresh."));
        return clearFollowUp.followUpTurn;
      }

      log.debug("Slash command not handled by harness; continuing through normal LLM path", slashCommand);
    }

    return handleLlmMessage({
      turn,
      chatInfo,
      context,
      persona,
      harness,
      harnessInstance,
      harnessOwnerKey: harnessSelection.ownerKey,
      resolvedBinding,
    });
  }

  return {
    async handleMessage(turn) {
      if (restartGate.isWaiting()) {
        restartGate.queueTurn(turn);
        log.debug("Queued incoming message while restart is waiting", turn.chatId);
        return;
      }
      await dispatchTurn(turn);
    },
  };
}
