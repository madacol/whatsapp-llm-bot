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
import { generateSessionTitle } from "./session-title.js";
import { getChatDb } from "../db.js";
import { resolveOutputVisibility } from "../chat-output-visibility.js";
import { createWorkspaceBindingService } from "../workspace-binding-service.js";
import { createWorkspaceControl } from "../workspace-control.js";
import { createWorkspaceLifecycleService } from "../workspace-lifecycle-service.js";
import { buildLiveInputText } from "./live-input-text.js";
import { defaultRestartGate } from "../restart-gate.js";
import { createBangCommandRouter } from "../commands/bang-command-router.js";

const log = createLogger("conversation:runner");
const NO_LIVE_INPUT_TARGET = Object.freeze({ supportsLiveInput: false });
/**
 * Type guard: checks that a content block is a text block.
 * @param {IncomingContentBlock} block
 * @returns {block is TextContentBlock}
 */
function isTextBlock(block) {
  return block.type === "text";
}

/**
 * @param {ResolvedChatBinding} binding
 * @param {TextContentBlock | undefined} firstBlock
 * @returns {boolean}
 */
function isArchivedWorkspaceCodingRequest(binding, firstBlock) {
  return binding.kind === "workspace"
    && binding.workspace.status === "archived"
    && !!firstBlock
    && !firstBlock.text.startsWith("!")
    && !firstBlock.text.startsWith("/");
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
 * @returns {string}
 */
function getTopLevelText(content) {
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
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
 * }} ConversationRunnerDeps
 */

/**
 * Create the conversation runner that owns command dispatch and harness orchestration.
 * @param {ConversationRunnerDeps} deps
 * @returns {{ handleMessage: (turn: ChatTurn) => Promise<void> }}
 */
export function createConversationRunner({ store, llmClient, restartCommandHandler, workspacePresentation, restartGate = defaultRestartGate }) {
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
  const bangCommandRouter = createBangCommandRouter({
    workspaceControl: workspaceLifecycle,
    addMessage,
    restartCommandHandler,
    cancelActiveRun: async (chatId, chatInfo) => {
      const selection = await resolveConversationHarnessSelection(chatInfo);
      const { harness } = resolveConversationHarnessFromSelection(selection);
      return !!(await harness?.cancel?.(chatId));
    },
  });
  let harnessRuntimeTurnSequence = 0;

  /**
   * Build the text passed into a live harness turn. Idle first turns avoid this
   * path so media transcription does not delay marking a new run as pending.
   * @param {{
   *   chatId: string,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   content: IncomingContentBlock[],
   * }} input
   * @returns {Promise<string>}
   */
  async function buildPendingRunInputText({ chatId, chatInfo, content }) {
    if (!hasNonTextContent(content)) {
      return getTopLevelText(content);
    }

    return buildLiveInputText({
      content,
      llmClient,
      mediaToTextModels: chatInfo?.media_to_text_models ?? {},
      db: getChatDb(chatId),
    });
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
   * Archive the active harness session, attaching a generated title when possible.
   * Falls back to a plain archive if title generation fails.
   * @param {string} chatId
   * @param {import("../store.js").ChatRow | undefined} chatInfo
   * @returns {Promise<HarnessSessionHistoryEntry | null>}
   */
  async function archiveSessionWithGeneratedTitle(chatId, chatInfo) {
    if (!chatInfo?.harness_session_id || !chatInfo?.harness_session_kind) {
      return archiveHarnessSession(chatId);
    }

    try {
      const messageRows = await getMessages(chatId);
      const title = await generateSessionTitle({
        llmClient,
        chatInfo,
        messageRows,
      });
      return archiveHarnessSession(chatId, { title });
    } catch (error) {
      log.warn("Failed to generate session title before archive:", error);
      return archiveHarnessSession(chatId);
    }
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
   * @returns {Promise<void>}
   */
  async function handleCommandMessage({ turn, chatId, senderIds, content, firstBlock, chatInfo, context, resolvedBinding }) {
    await bangCommandRouter({ turn, chatId, senderIds, content, firstBlock, chatInfo, context, resolvedBinding });
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
   *   getResumeCursor: () => string | null,
   *   saveHarnessSessionAndBinding: import("../store.js").Store["saveHarnessSession"],
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
    getResumeCursor,
    saveHarnessSessionAndBinding,
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
      const result = await adapter.sendTurn({
        ...turnInput,
        chatId,
        turnId,
        runConfig: turnInput.runConfig ?? runConfig,
        resumeCursor: getResumeCursor(),
        hooks,
      });
      await Promise.allSettled([...pendingEventHandlers]);
      const activeSession = adapter
        .listSessions()
        .find((session) => session.chatId === chatId);
      const currentResumeCursor = getResumeCursor();
      if (activeSession?.resumeCursor) {
        await saveHarnessSessionAndBinding(chatId, {
          id: activeSession.resumeCursor,
          kind: /** @type {HarnessSessionRef["kind"]} */ (harness.getName()),
        });
      } else if (currentResumeCursor && activeSession && ["stopped", "error"].includes(activeSession.status)) {
        await saveHarnessSessionAndBinding(chatId, null);
      }
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
  }) {
    const { chatId } = turn;
    const harnessName = harness.getName();
    const runConfig = buildRunConfig(chatId, chatInfo, turn.chatName, harnessName, resolvedBinding);
    const turnId = createHarnessRuntimeTurnId(chatId, ++harnessRuntimeTurnSequence);
    let currentResumeCursor = chatInfo?.harness_session_kind === harnessName
      ? chatInfo.harness_session_id
      : null;
    if (harnessInstance?.adapter) {
      const startedAdapterSession = await harnessInstance.adapter.startSession({
        chatId,
        runConfig,
        resumeCursor: currentResumeCursor,
      });
      currentResumeCursor = startedAdapterSession.resumeCursor ?? currentResumeCursor;
    }

    /**
     * @param {"running" | "ready" | "stopped" | "error"} status
     * @param {string | null | undefined} resumeCursor
     * @returns {void}
     */
    const upsertSessionBinding = (status, resumeCursor) => {
      if (!harnessInstance) {
        return;
      }
      if (resumeCursor !== undefined) {
        currentResumeCursor = resumeCursor;
      }
      harnessSessionDirectory.upsert({
        chatId,
        harnessName,
        instanceId: harnessInstance.instanceId,
        status,
        activeTurnId: status === "running" ? turnId : null,
        resumeCursor: currentResumeCursor,
        runtimeMode: runConfig.sandboxMode ?? null,
        runtimePayload: {
          workdir: runConfig.workdir ?? null,
          model: runConfig.model ?? null,
          reasoningEffort: runConfig.reasoningEffort ?? null,
          approvalPolicy: runConfig.approvalPolicy ?? null,
          approvalsReviewer: runConfig.approvalsReviewer ?? null,
        },
      });
    };

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
    upsertSessionBinding("running", undefined);

    /** @type {import("../store.js").Store["saveHarnessSession"]} */
    const saveHarnessSessionAndBinding = async (sessionChatId, sessionRef) => {
      await saveHarnessSession(sessionChatId, sessionRef);
      if (sessionChatId === chatId) {
        upsertSessionBinding(sessionRef ? "ready" : "stopped", sessionRef?.id ?? null);
      }
    };

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
    const result = await runProviderTurnWithRuntimeEvents({
      chatId,
      harness,
      harnessInstance,
      hooks,
      runConfig,
      turnInput: await buildHarnessTurnInput({
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
      }),
      turnId,
      getResumeCursor: () => currentResumeCursor,
      saveHarnessSessionAndBinding,
    });
    upsertSessionBinding("ready", undefined);

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
   *   isSlashCommand?: boolean,
   *   resolvedBinding: ResolvedChatBinding,
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
    isSlashCommand,
    resolvedBinding,
  }) {
    const { chatId, senderIds, content, senderName, facts } = turn;
    const willRespond = isSlashCommand || shouldRespond(chatInfo, facts);

    /** @type {UserMessage} */
    const message = {
      role: "user",
      content,
      ...(facts.isGroup && senderName ? { senderName } : {}),
    };
    await addMessage(chatId, message, senderIds);

    if (!willRespond) {
      return null;
    }

    log.debug("LLM will respond");

    if (!harness) {
      await context.reply(contentEvent(
        "error",
        "No ACP harness is selected for this chat and the central default is disabled. Set one with `!s harness codex`.",
      ));
      return null;
    }

    const userText = runCoordinator.hasPendingRun(chatId)
      ? await buildPendingRunInputText({ chatId, chatInfo, content })
      : getTopLevelText(content);
    const lifecycleDecision = await runCoordinator.beginRun({
      turn,
      userText,
      liveInputTarget: resolveProviderLiveInputTarget(harnessInstance),
      ownerKey: harnessOwnerKey,
    });
    if (lifecycleDecision.status === "buffered") {
      log.debug("Buffered message for pending harness run on chat", chatId);
      return null;
    }
    if (lifecycleDecision.status === "injected") {
      log.debug("Injected message into active harness query for chat", chatId);
      return null;
    }

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
    } catch (error) {
      const binding = harnessSessionDirectory.getBinding(chatId);
      if (binding) {
        harnessSessionDirectory.upsert({ ...binding, status: "error" });
      }
      log.error("handleLlmMessage failed:", error);
      const errorMessage = errorToString(error);
      try {
        await context.reply(contentEvent("error", errorMessage));
      } catch {
        // best effort
      }
    } finally {
      nextTurn = runCoordinator.finishRun(chatId);
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
    const harnessSelection = await resolveConversationHarnessSelection(chatInfo);

    const firstBlock = content.find(isTextBlock);
    if (isArchivedWorkspaceCodingRequest(resolvedBinding, firstBlock)) {
      await context.reply(contentEvent(
        "error",
        "This workspace is archived and no longer accepts work.",
      ));
      return null;
    }

    if (firstBlock?.text?.startsWith("!")) {
      await handleCommandMessage({
        turn,
        chatId,
        senderIds,
        content,
        firstBlock,
        chatInfo,
        context,
        resolvedBinding,
      });
      return null;
    }

    const isSlashCommand = firstBlock?.text?.startsWith("/");
    if (!isSlashCommand && runCoordinator.hasPendingRun(chatId)) {
      /** @type {UserMessage} */
      const message = {
        role: "user",
        content,
        ...(turn.facts.isGroup && turn.senderName ? { senderName: turn.senderName } : {}),
      };
      await addMessage(chatId, message, senderIds);
      if (!shouldRespond(chatInfo, turn.facts)) {
        return null;
      }
      const userText = await buildPendingRunInputText({ chatId, chatInfo, content });
      const lifecycleDecision = await runCoordinator.beginRun({
        turn,
        userText,
        ownerKey: harnessSelection.ownerKey,
      });
      if (lifecycleDecision.status === "buffered") {
        log.debug("Buffered message for pending harness run on chat", chatId);
      } else if (lifecycleDecision.status === "injected") {
        log.debug("Injected message into active harness query for chat", chatId);
      }
      return null;
    }

    const { persona, harness, harnessInstance } = resolveConversationHarnessFromSelection(harnessSelection);

    if (isSlashCommand && firstBlock) {
      if (!chatInfo?.is_enabled) {
        await context.reply(contentEvent("error", `Bot is not enabled in this chat. Use ${formatChatSettingsCommand("enabled on")}`));
        return null;
      }

      const slashCommand = firstBlock.text.slice(1).trim().toLowerCase();
      /** @type {HarnessCommandContext} */
      const commandInput = {
        chatId,
        chatInfo,
        context,
        command: slashCommand,
        sessionControl: {
          archive: async (sessionChatId) => archiveSessionWithGeneratedTitle(sessionChatId, chatInfo),
          getHistory: getHarnessSessionHistory,
          restore: restoreHarnessSession,
        },
        sessionForkControl: {
          save: saveHarnessSession,
          push: pushHarnessForkStack,
          pop: popHarnessForkStack,
        },
      };
      const handled = harness
        ? await harness.handleCommand(commandInput)
        : false;
      if (handled) {
        return null;
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
      isSlashCommand: !!isSlashCommand,
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
