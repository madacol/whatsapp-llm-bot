import { createAppOutputPort } from "../app-output-port.js";
import { prepareMessages, shouldRespond } from "../message-formatting.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { createLogger } from "../logger.js";
import { getChatDb } from "../db.js";
import {
  DEFAULT_MEDIA_INPUT_CONTEXT_MESSAGE_LIMIT,
  buildMediaInputContextMessages,
} from "../media-input-enrichment.js";
import { createWorkspaceBindingService } from "../workspace-binding-service.js";
import { createWorkspaceControl } from "../workspace-control.js";
import { createWorkspaceLifecycleService } from "../workspace-lifecycle-service.js";
import { buildLiveInputText } from "./live-input-text.js";
import { decideChannelInputRoute } from "./channel-input-routing.js";
import { createAgentRuntime } from "./agent-runtime.js";
import { createCommandOrchestration } from "./command-orchestration.js";
import { DEFAULT_OUTPUT_VISIBILITY, resolveOutputVisibility } from "../chat-output-visibility.js";
import {
  createWaitSendBatchStore,
  parseWaitSendBatchCommandText,
} from "./wait-send-batching.js";

const log = createLogger("conversation:runner");
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
 * @param {IncomingContentBlock[]} content
 * @returns {boolean}
 */
function hasNonTextContent(content) {
  return content.some((block) => block.type !== "text");
}

/**
 * Keep payload content carried by a control command, such as quoted or attached
 * media, while stripping the command text itself from any eventual agent turn.
 * @param {IncomingContentBlock[]} content
 * @param {TextContentBlock} commandBlock
 * @param {string} [replacementText]
 * @returns {IncomingContentBlock[]}
 */
function getContentWithoutCommandBlock(content, commandBlock, replacementText = "") {
  let removed = false;
  /** @type {IncomingContentBlock[]} */
  const blocks = [];
  for (const block of content) {
    if (!removed && block === commandBlock) {
      removed = true;
      if (replacementText) {
        blocks.push({ ...commandBlock, text: replacementText });
      }
      continue;
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * @param {TextContentBlock} commandBlock
 * @param {"wait" | "send" | "cancel"} command
 * @returns {string}
 */
function getWaitSendCommandPayloadText(commandBlock, command) {
  const match = commandBlock.text.match(new RegExp(`^/${command}(?:\\s+([\\s\\S]*))?$`, "i"));
  return match?.[1]?.trim() ?? "";
}

/**
 * @param {IncomingContentBlock[]} content
 * @param {TextContentBlock} commandBlock
 * @returns {boolean}
 */
function hasDirectMediaPayload(content, commandBlock) {
  return content.some((block) =>
    block !== commandBlock
    && (block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file"));
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
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @param {import("../chat-output-visibility.js").OutputVisibility} [visibility]
 * @returns {{
 *   onAudioTranscriptionStart: (event: { block: AudioContentBlock, modelId: string }) => Promise<void>,
 *   onAudioTranscriptionComplete: (event: { block: AudioContentBlock, modelId: string, transcription: string }) => Promise<void>,
 *   onAudioTranscriptionFailure: (event: { block: AudioContentBlock, modelId: string, error: unknown }) => Promise<void>,
 * }}
 */
export function createAudioTranscriptionStatusObserver(context, visibility = DEFAULT_OUTPUT_VISIBILITY) {
  const outputVisibility = resolveOutputVisibility(visibility);
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
        presentationCategory: "transcription",
        presentationStatus: "started",
      });
    }
    return handlePromise;
  }

  /**
   * @param {"completed" | "failed"} status
   * @param {string} text
   * @returns {Promise<MessageHandle | undefined>}
   */
  async function sendTranscriptionStatusUpdate(status, text) {
    return appOutput.sendPlain(text, {
      presentationCategory: "transcription",
      presentationStatus: status,
    });
  }

  if (outputVisibility.transcription === "hidden") {
    return {
      onAudioTranscriptionStart: async () => {},
      onAudioTranscriptionComplete: async () => {},
      onAudioTranscriptionFailure: async () => {},
    };
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
      const inspectText = formatAudioTranscriptionInspectText(transcriptions);
      if (outputVisibility.transcription === "pinnedIndicator") {
        await sendTranscriptionStatusUpdate("completed", "Transcribed");
        return;
      }
      if (outputVisibility.transcription === "fullDetails") {
        await handle?.update({
          kind: "text",
          text: `Transcribed\n\n${inspectText}`,
        });
        return;
      }
      handle?.setInspect({
        kind: "text",
        text: inspectText,
      });
      await handle?.update({
        kind: "text",
        text: "Transcribed",
      });
    },
    onAudioTranscriptionFailure: async () => {
      const handle = await ensureHandle();
      if (outputVisibility.transcription === "pinnedIndicator") {
        await sendTranscriptionStatusUpdate("failed", "Audio transcription failed.");
        return;
      }
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
    getMessages,
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
   *   contextMessages?: ChatMessage[],
   * }} input
   * @returns {Promise<string>}
   */
  async function buildPendingRunInputText({ chatId, chatInfo, content, audioTranscriptionObserver, contextMessages }) {
    if (!hasNonTextContent(content)) {
      return getTopLevelText(content);
    }

    const text = await buildLiveInputText({
      content,
      llmClient,
      mediaToTextModels: chatInfo?.media_to_text_models ?? {},
      db: getChatDb(chatId),
      contextMessages: contextMessages ?? await buildStoredMediaInputContextMessages(chatId),
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
   * @param {string} chatId
   * @returns {Promise<ChatMessage[]>}
   */
  async function buildStoredMediaInputContextMessages(chatId) {
    const chatMessages = await getMessages(chatId, undefined, DEFAULT_MEDIA_INPUT_CONTEXT_MESSAGE_LIMIT);
    const { messages } = prepareMessages(chatMessages);
    return buildMediaInputContextMessages(messages, messages.length, {
      limit: DEFAULT_MEDIA_INPUT_CONTEXT_MESSAGE_LIMIT,
    });
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
      audioTranscriptionObserver: createAudioTranscriptionStatusObserver(
        context,
        resolveOutputVisibility(chatInfo?.output_visibility),
      ),
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
    audioTranscriptionObserver,
  }) {
    const resolvedAudioTranscriptionObserver = audioTranscriptionObserver ?? createAudioTranscriptionStatusObserver(
      context,
      resolveOutputVisibility(chatInfo?.output_visibility),
    );
    const appOutput = createAppOutputPort(context);
    const { chatId, senderIds, content } = turn;
    const message = buildUserMessage(turn);
    const pendingMediaContextMessages = agentRuntime.hasPendingRun(chatId) && hasNonTextContent(content)
      ? await buildStoredMediaInputContextMessages(chatId)
      : undefined;
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
      ? await buildPendingRunInputText({
        chatId,
        chatInfo,
        content,
        audioTranscriptionObserver: resolvedAudioTranscriptionObserver,
        contextMessages: pendingMediaContextMessages,
      })
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
      audioTranscriptionObserver: resolvedAudioTranscriptionObserver,
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

    await createChat(chatId, { defaults: turn.chatCreationDefaults });

    const chatInfo = await getChat(chatId);
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
      const commandPayloadText = hasDirectMediaPayload(content, firstBlock)
        ? getWaitSendCommandPayloadText(firstBlock, waitSendCommand.command)
        : "";
      const seedContent = getContentWithoutCommandBlock(content, firstBlock, commandPayloadText);
      const seedInputText = seedContent.length > 0
        ? await buildBatchInputText({
          chatId,
          chatInfo,
          content: seedContent,
          context,
        })
        : "";
      const batchState = waitSendBatches.startOrAppend(turn, seedContent, seedInputText);
      await appOutput.replyWithPlain(
        batchState.alreadyOpen
          ? `Batch already open. ${batchState.messageCount} message${batchState.messageCount === 1 ? "" : "s"} queued. Send \`/send\` when ready.`
          : `Batch started. ${batchState.messageCount} message${batchState.messageCount === 1 ? "" : "s"} queued. Send \`/send\` when ready.`,
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
      const audioTranscriptionObserver = createAudioTranscriptionStatusObserver(
        context,
        resolveOutputVisibility(chatInfo?.output_visibility),
      );
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
