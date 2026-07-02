import { createAppOutputPort } from "../app-output-port.js";
import { shouldRespond } from "../message-formatting.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { createLogger } from "../logger.js";
import { getChatDb } from "../db.js";
import { createWorkspaceBindingService } from "../workspace-binding-service.js";
import { createWorkspaceControl } from "../workspace-control.js";
import { createWorkspaceLifecycleService } from "../workspace-lifecycle-service.js";
import { buildLiveInputText } from "./live-input-text.js";
import { decideChannelInputRoute } from "./channel-input-routing.js";
import { createAgentRuntime } from "./agent-runtime.js";
import { createCommandOrchestration } from "./command-orchestration.js";
import {
  createWaitSendBatchStore,
  parseWaitSendBatchCommandText,
} from "./wait-send-batching.js";

const log = createLogger("conversation:runner");
const DEFAULT_LIVE_INPUT_FALLBACK_DELAY_MS = 1500;
const HTTP_API_CHAT_ID_PREFIX = "api:";
/**
 * Type guard: checks that a content block is a text block.
 * @param {IncomingContentBlock} block
 * @returns {block is TextContentBlock}
 */
function isTextBlock(block) {
  return block.type === "text";
}

/**
 * @param {IncomingContentBlock[]} content
 * @returns {boolean}
 */
function hasNonTextContent(content) {
  return content.some((block) => block.type !== "text");
}

/**
 * HTTP API transport clients are authenticated at the transport boundary and
 * use synthetic `api:*` chat IDs. They should not inherit WhatsApp's
 * disabled-by-default chat gate.
 * @param {string} chatId
 * @returns {boolean}
 */
function isHttpApiClientChat(chatId) {
  return chatId.startsWith(HTTP_API_CHAT_ID_PREFIX);
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
  const appOutput = createAppOutputPort(context);
  /** @type {Promise<MessageHandle | undefined> | null} */
  let handlePromise = null;
  /** @type {string[]} */
  const transcriptions = [];

  /**
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function ensureHandle() {
    if (!handlePromise) {
      handlePromise = appOutput.replyWithPlain("Transcribing audio...", {
        replyToTriggeringMessage: true,
      });
    }
    return handlePromise;
  }

  return {
    onAudioTranscriptionStart: async () => {
      await ensureHandle();
    },
    onAudioTranscriptionComplete: async ({ transcription }) => {
      const isNewTranscription = !transcriptions.includes(transcription);
      const handle = await ensureHandle();
      if (!isNewTranscription) {
        return;
      }
      transcriptions.push(transcription);
      handle?.setInspect({
        kind: "text",
        text: formatAudioTranscriptionInspectText(transcriptions),
      });
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
 * @param {ChannelInput} turn
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
 * @typedef {import("../store.js").Store} Store
 *
 * @typedef {{
 *   store: Store,
 *   llmClient: LlmClient,
 *   restartCommandHandler?: ReturnType<typeof import("../commands/restart-command.js").createRestartCommandHandler>,
 *   transport?: ChatTransport,
 *   workspacePresentation?: WorkspacePresentationPort,
 *   liveInputFallbackDelayMs?: number,
 * }} ConversationRunnerDeps
 *
 * @typedef {Awaited<ReturnType<ReturnType<typeof createAgentRuntime>["resolveSelection"]>>} AgentRuntimeSelection
 */

/**
 * Create the conversation runner that owns command dispatch and runtime orchestration.
 * @param {ConversationRunnerDeps} deps
 * @returns {{ handleMessage: (input: ChannelInput) => Promise<void> }}
 */
export function createConversationRunner({
  store,
  llmClient,
  restartCommandHandler,
  workspacePresentation,
  liveInputFallbackDelayMs = DEFAULT_LIVE_INPUT_FALLBACK_DELAY_MS,
}) {
  const {
    addMessage,
    createChat,
    getChat,
    setChatEnabled,
  } = store;

  const agentRuntime = createAgentRuntime({ store, llmClient, log });
  const workspaceBinding = createWorkspaceBindingService(store);
  const workspaceControl = createWorkspaceControl({ store, workspacePresentation });
  const workspaceLifecycle = createWorkspaceLifecycleService({
    workspaceControl,
    workspacePresentation,
    dispatchTurn,
  });
  const waitSendBatches = createWaitSendBatchStore();

  const commandOrchestration = createCommandOrchestration({
    workspaceControl: workspaceLifecycle,
    addMessage,
    restartCommandHandler,
    agentRuntime,
  });

  /**
   * Build the text passed into an active runtime turn. Idle first turns avoid this
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
   * @param {{
   *   chatId: string,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   content: IncomingContentBlock[],
   *   context: ExecuteActionContext,
   * }} input
   * @returns {Promise<string>}
   */
  async function buildBatchInputText({ chatId, chatInfo, content, context }) {
    return buildPendingRunInputText({
      chatId,
      chatInfo,
      content,
      audioTranscriptionObserver: createAudioTranscriptionStatusObserver(context),
    });
  }

  /**
   * @param {ChannelInput} turn
   * @returns {Promise<void>}
   */
  async function dispatchTurn(turn) {
    /** @type {ChannelInput | null} */
    let nextTurn = turn;
    while (nextTurn) {
      nextTurn = await handleSingleMessage(nextTurn);
    }
  }

  /**
   * Replay a live-input message as a normal turn if provider steering stays
   * unavailable after the active query already rejected it.
   * @param {ChannelInput} turn
   * @param {() => Promise<void>} interruptActiveTurn
   * @returns {void}
   */
  function scheduleLiveInputReplay(turn, interruptActiveTurn) {
    const timer = setTimeout(() => {
      const replay = agentRuntime.preparePendingLiveInputReplay(turn.chatId, turn);
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
   * Handle a regular (non-command) message by delegating to the selected runtime.
   * @param {{
   *   turn: ChannelInput,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   runtimeSelection: AgentRuntimeSelection,
   *   resolvedBinding: ResolvedChatBinding,
   *   prebuiltInputText?: string,
   *   audioTranscriptionObserver?: ReturnType<typeof createAudioTranscriptionStatusObserver>,
   * }} input
   * @returns {Promise<ChannelInput | null>}
   */
  async function handleLlmMessage({
    turn,
    chatInfo,
    context,
    runtimeSelection,
    resolvedBinding,
    prebuiltInputText,
    audioTranscriptionObserver = createAudioTranscriptionStatusObserver(context),
  }) {
    const appOutput = createAppOutputPort(context);
    const { chatId, senderIds, content } = turn;
    const message = buildUserMessage(turn);
    await addMessage(chatId, message, senderIds);

    logInfoWhen(hasNonTextContent(content) || agentRuntime.hasPendingRun(chatId), "LLM will respond", {
      chatId,
      contentTypes: summarizeContentTypes(content),
      hasPendingRun: agentRuntime.hasPendingRun(chatId),
    });

    if (!agentRuntime.hasSelectedRuntime(runtimeSelection)) {
      await appOutput.replyWithError("No ACP harness is selected for this chat and the central default is disabled. Set one with `!s harness codex`.");
      return null;
    }

    const userText = prebuiltInputText ?? (agentRuntime.hasPendingRun(chatId)
      ? await buildPendingRunInputText({ chatId, chatInfo, content, audioTranscriptionObserver })
      : getTopLevelText(content));
    const lifecycleDecision = await agentRuntime.beginRun({
      turn,
      userText,
      selection: runtimeSelection,
      allowLiveInputTarget: true,
    });
    logInfoWhen(hasNonTextContent(content) || lifecycleDecision.status !== "started", "Agent runtime lifecycle decision", {
      chatId,
      status: lifecycleDecision.status,
      reason: lifecycleDecision.reason ?? null,
      userTextLength: userText.length,
      contentTypes: summarizeContentTypes(content),
    });
    if (lifecycleDecision.status === "buffered") {
      log.debug("Buffered message for pending agent runtime run on chat", chatId);
      return null;
    }
    if (lifecycleDecision.status === "injected") {
      log.debug("Injected message into active agent runtime query for chat", chatId);
      return null;
    }

    return agentRuntime.runStartedTurn({
      turn,
      chatInfo,
      context,
      message,
      selection: runtimeSelection,
      resolvedBinding,
      prebuiltInputText,
      audioTranscriptionObserver,
    });
  }

  /**
   * Handle one normalized ChannelInput from the transport.
   * @param {ChannelInput} turn
   * @returns {Promise<ChannelInput | null>}
   */
  async function handleSingleMessage(turn) {
    const { chatId, senderIds, content } = turn;

    log.debug("INCOMING MESSAGE:", JSON.stringify(turn, null, 2));

    await createChat(chatId);

    let chatInfo = await getChat(chatId);
    if (isHttpApiClientChat(chatId) && chatInfo && !chatInfo.is_enabled) {
      await setChatEnabled(chatId, true);
      chatInfo = await getChat(chatId);
    }
    const context = createMessageActionContext(turn);
    const appOutput = createAppOutputPort(context);
    const resolvedBinding = await workspaceBinding.resolveChatBinding(
      chatId,
      chatInfo?.harness_cwd,
      turn.chatName,
      turn.facts.isGroup,
    );
    const firstBlock = content.find(isTextBlock);
    const route = decideChannelInputRoute({
      chatInfo,
      resolvedBinding,
      firstText: firstBlock?.text ?? null,
      hasPendingRun: agentRuntime.hasPendingRun(chatId),
      shouldRespond: shouldRespond(chatInfo, turn.facts),
    });
    const routeShouldLogInfo = hasNonTextContent(content)
      || agentRuntime.hasPendingRun(chatId)
      || route.type !== "agent-invocation";
    logInfoWhen(routeShouldLogInfo, "ChannelInput route decision", {
      chatId,
      route: route.type,
      shouldRespond: "shouldRespond" in route ? route.shouldRespond : shouldRespond(chatInfo, turn.facts),
      hasPendingRun: agentRuntime.hasPendingRun(chatId),
      contentTypes: summarizeContentTypes(content),
      firstTextLength: firstBlock?.text.length ?? 0,
      addressedToBot: turn.facts.addressedToBot,
      repliedToBot: turn.facts.repliedToBot,
    });

    if (route.type === "archived-workspace-error") {
      await appOutput.replyWithError("This workspace is archived and no longer accepts work.");
      return null;
    }

    if (route.type === "disabled-slash-command") {
      await commandOrchestration.handleCommand({
        route,
        turn,
        chatInfo,
        context,
        resolvedBinding,
      });
      return null;
    }

    const waitSendCommand = firstBlock ? parseWaitSendBatchCommandText(firstBlock.text) : null;
    if (waitSendCommand?.command === "wait" && firstBlock) {
      const batchState = waitSendBatches.startOrAppend(turn, []);
      await appOutput.replyWithPlain(
        batchState.alreadyOpen
          ? `Batch already open. ${batchState.messageCount} message${batchState.messageCount === 1 ? "" : "s"} queued. Send /send when ready.`
          : `Batch started. ${batchState.messageCount} message${batchState.messageCount === 1 ? "" : "s"} queued. Send /send when ready.`,
      );
      return null;
    }

    if (waitSendCommand?.command === "send" && firstBlock) {
      const committed = waitSendBatches.commit(turn, []);
      if (!committed) {
        await appOutput.replyWithPlain("No pending batch. Use /wait first.");
        return null;
      }
      const runtimeSelection = await agentRuntime.resolveSelection(chatInfo);
      return handleLlmMessage({
        turn: committed.turn,
        chatInfo,
        context,
        runtimeSelection,
        resolvedBinding,
        prebuiltInputText: committed.inputText,
      });
    }

    if (waitSendCommand?.command === "cancel" && firstBlock) {
      const cancelled = waitSendBatches.cancel(chatId);
      if (!cancelled) {
        await appOutput.replyWithPlain("No pending batch. Use /wait first.");
        return null;
      }
      await appOutput.replyWithPlain(
        `Batch cancelled. Discarded ${cancelled.messageCount} message${cancelled.messageCount === 1 ? "" : "s"}.`,
      );
      return null;
    }

    if (route.type === "bang-command" && firstBlock) {
      const result = await commandOrchestration.handleCommand({
        route,
        turn,
        chatInfo,
        context,
        resolvedBinding,
      });
      return result.kind === "handled" ? result.followUpTurn : null;
    }

    if (route.type === "pending-followup") {
      if (!route.shouldRespond) {
        await addMessage(chatId, buildUserMessage(turn), senderIds);
        return null;
      }
      if (waitSendBatches.has(chatId)) {
        waitSendBatches.append(turn, content, await buildBatchInputText({
          chatId,
          chatInfo,
          content,
          context,
        }));
        return null;
      }
      const runtimeSelection = await agentRuntime.resolveSelection(chatInfo);
      const audioTranscriptionObserver = createAudioTranscriptionStatusObserver(context);
      const userText = await buildPendingRunInputText({
        chatId,
        chatInfo,
        content,
        audioTranscriptionObserver,
      });
      if (!agentRuntime.hasPendingRun(chatId)) {
        return handleLlmMessage({
          turn,
          chatInfo,
          context,
          runtimeSelection,
          resolvedBinding,
          audioTranscriptionObserver,
        });
      }
      const lifecycleDecision = await agentRuntime.beginRun({
        turn,
        userText,
        selection: runtimeSelection,
        allowLiveInputTarget: false,
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
        log.debug("Buffered message for pending agent runtime run on chat", chatId);
        if (lifecycleDecision.reason === "live-input-retry") {
          scheduleLiveInputReplay(turn, async () => {
            await agentRuntime.interruptTurn(runtimeSelection, chatId);
          });
        }
      } else if (lifecycleDecision.status === "injected") {
        await addMessage(chatId, buildUserMessage(turn), senderIds);
        log.debug("Injected message into active agent runtime query for chat", chatId);
      } else if (lifecycleDecision.status === "started") {
        const message = buildUserMessage(turn);
        await addMessage(chatId, message, senderIds);
        if (!agentRuntime.hasSelectedRuntime(runtimeSelection)) {
          await appOutput.replyWithError("No ACP harness is selected for this chat and the central default is disabled. Set one with `!s harness codex`.");
          agentRuntime.finishRun(chatId);
          return null;
        }
        return agentRuntime.runStartedTurn({
          turn,
          chatInfo,
          context,
          message,
          selection: runtimeSelection,
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

    if (route.type === "slash-command" && firstBlock) {
      const result = await commandOrchestration.handleCommand({
        route,
        turn,
        chatInfo,
        context,
        resolvedBinding,
      });
      if (result.kind === "handled") {
        return result.followUpTurn;
      }

      log.debug("Slash command not handled by command orchestration; continuing through normal LLM path", firstBlock.text);
    }

    if (route.type === "agent-invocation" && waitSendBatches.has(chatId)) {
      waitSendBatches.append(turn, content, await buildBatchInputText({
        chatId,
        chatInfo,
        content,
        context,
      }));
      return null;
    }

    const runtimeSelection = await agentRuntime.resolveSelection(chatInfo);
    return handleLlmMessage({
      turn,
      chatInfo,
      context,
      runtimeSelection,
      resolvedBinding,
    });
  }

  return {
    async handleMessage(turn) {
      await dispatchTurn(turn);
    },
  };
}
