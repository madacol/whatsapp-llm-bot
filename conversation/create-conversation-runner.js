import { CANCEL_COMMAND, formatChatSettingsCommand } from "../chat-commands.js";
import { getChatAction, getChatActions, getAction } from "../actions.js";
import { getAgent } from "../agents.js";
import { storeAndLinkHtml } from "../html-store.js";
import {
  createHarnessRuntimeEventDispatcher,
  resolveHarnessInstance,
  resolveHarnessName,
  createHarnessRunCoordinator,
  getHarnessSessionDirectory,
} from "#harnesses";
import { createAppRunner } from "./app-runner.js";
import { getHarnessInstanceConfig } from "../harness-config.js";
import { contentEvent } from "../outbound-events.js";
import {
  shouldRespond,
  parseCommandArgs,
} from "../message-formatting.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { errorToString, isHtmlContent } from "../utils.js";
import { createLogger } from "../logger.js";
import { buildAgentIoHooks } from "./build-agent-io-hooks.js";
import { buildHarnessRunRequest, buildHarnessTurnInput } from "./build-harness-run-request.js";
import { buildRunConfig } from "./build-run-config.js";
import { generateSessionTitle } from "./session-title.js";
import { getChatDb } from "../db.js";
import { resolveOutputVisibility } from "../chat-output-visibility.js";
import { createWorkspaceBindingService } from "../workspace-binding-service.js";
import { tryHandleWorkspaceCommand } from "../workspace-command-router.js";
import { createWorkspaceControl } from "../workspace-control.js";
import { createWorkspaceLifecycleService } from "../workspace-lifecycle-service.js";
import { buildLiveInputText } from "./live-input-text.js";
import { defaultRestartGate } from "../restart-gate.js";

const log = createLogger("conversation:runner");
const PRESENCE_LEASE_TTL_MS = 20_000;
/**
 * Type guard: checks that an action has a command string.
 * @param {Action} action
 * @returns {action is Action & { command: string }}
 */
function hasCommand(action) {
  return typeof action.command === "string";
}

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
 * @param {ToolContentBlock} block
 * @returns {ToolContentBlock | { type: "textual", text: string }}
 */
function normalizeDeliveredContentBlock(block) {
  if ((block.type === "text" || block.type === "markdown") && typeof block.text === "string") {
    return { type: "textual", text: block.text };
  }
  return block;
}

/**
 * @param {SendContent} content
 * @returns {string}
 */
function getDeliveredContentSignature(content) {
  if (Array.isArray(content)) {
    return JSON.stringify(content.map(normalizeDeliveredContentBlock));
  }
  if (typeof content === "object" && content !== null) {
    return JSON.stringify(normalizeDeliveredContentBlock(content));
  }
  return JSON.stringify(content);
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
 * Resolve the persona and harness for the current chat.
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @returns {Promise<{ persona: AgentDefinition | null, harness: AgentHarness, harnessInstance: ReturnType<typeof resolveHarnessInstance> | null }>}
 */
async function resolveConversationHarness(chatInfo) {
  const persona = chatInfo?.active_persona
    ? await getAgent(chatInfo.active_persona)
    : null;
  const selectedHarnessName = resolveHarnessName(persona, chatInfo);
  if (!selectedHarnessName) {
    return {
      persona,
      harness: createAppRunner(),
      harnessInstance: null,
    };
  }
  const { driver, instanceId, config: harnessConfig, displayName } = getHarnessInstanceConfig(
    chatInfo?.harness_config,
    selectedHarnessName,
  );
  const harnessName = driver ?? selectedHarnessName;
  const harnessInstance = resolveHarnessInstance(harnessName, {
    instanceId,
    config: harnessConfig,
    displayName,
  });
  return {
    persona,
    harness: harnessInstance.harness,
    harnessInstance,
  };
}

/**
 * @typedef {import("../store.js").Store} Store
 *
 * @typedef {{
 *   store: Store,
 *   llmClient: LlmClient,
 *   getActionsFn: typeof import("../actions.js").getActions,
 *   executeActionFn: typeof import("../actions.js").executeAction,
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
export function createConversationRunner({ store, llmClient, getActionsFn, executeActionFn, workspacePresentation, restartGate = defaultRestartGate }) {
  const {
    addMessage,
    updateToolMessage,
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
   *   actions: Action[],
   *   actionResolver: (name: string) => Promise<AppAction | null>,
   *   resolvedBinding: ResolvedChatBinding,
   * }} input
   * @returns {Promise<void>}
   */
  async function handleCommandMessage({ turn, chatId, senderIds, content, firstBlock, chatInfo, context, actions, actionResolver, resolvedBinding }) {
    const inputText = firstBlock.text.slice(1).trim();
    const commandText = inputText.toLowerCase();

    if (await tryHandleWorkspaceCommand({
      context,
      binding: resolvedBinding,
      inputText,
      workspaceControl: workspaceLifecycle,
      seedSourceTurn: {
        senderIds: turn.senderIds,
        senderJids: turn.senderJids,
        senderName: turn.senderName,
      },
    })) {
      return;
    }

    if (commandText === CANCEL_COMMAND) {
      const { harness } = await resolveConversationHarness(chatInfo);
      if (harness.cancel?.(chatId)) {
        await context.reply(contentEvent("tool-result", "Cancelled."));
      } else {
        await context.reply(contentEvent("tool-result", "Nothing to cancel."));
      }
      return;
    }

    const commandActions = actions.filter(hasCommand);
    const action = commandActions
      .sort((a, b) => b.command.length - a.command.length)
      .find((candidate) => commandText === candidate.command || commandText.startsWith(candidate.command + " "));

    if (!action) {
      await context.reply(contentEvent("error", `Unknown command: ${commandText.split(" ")[0]}`));
      return;
    }

    /** @type {UserMessage} */
    const commandMessage = { role: "user", content };
    await addMessage(chatId, commandMessage, senderIds);

    const argsText = inputText.slice(action.command.length).trim();
    const args = argsText ? argsText.split(" ") : [];
    const params = parseCommandArgs(args, action.parameters);

    log.debug("executing", action.name, params);

    try {
      const { result, afterResponse } = await executeActionFn(action.name, context, params, { actionResolver, llmClient });

      /** @type {MessageHandle | undefined} */
      let responseHandle;
      if (isHtmlContent(result)) {
        const linkText = await storeAndLinkHtml(chatId, result);
        responseHandle = await context.reply(contentEvent("tool-result", linkText));
      } else if (typeof result === "string") {
        responseHandle = await context.reply(contentEvent("tool-result", result));
      } else if (Array.isArray(result)) {
        responseHandle = await context.reply(contentEvent("tool-result", /** @type {ToolContentBlock[]} */ (result)));
      } else {
        responseHandle = await context.reply(contentEvent("tool-result", JSON.stringify(result, null, 2)));
      }
      await afterResponse?.({ handle: responseHandle });
    } catch (error) {
      log.error("Error executing command:", error);
      await context.reply(contentEvent("error", `Error: ${errorToString(error)}`));
    }
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
    getResumeCursor,
    saveHarnessSessionAndBinding,
  }) {
    const runtimeDispatcher = createHarnessRuntimeEventDispatcher({
      provider: harness.getName(),
      messages: turnInput.messages ?? [],
      hooks,
      workdir: runConfig.workdir ?? null,
    });
    /** @type {Set<Promise<void>>} */
    const pendingEventHandlers = new Set();
    let eventChain = Promise.resolve();
    const unsubscribe = harnessInstance.adapter.subscribeEvents?.((event) => {
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
      const result = await harnessInstance.adapter.sendTurn({
        ...turnInput,
        chatId,
        runConfig: turnInput.runConfig ?? runConfig,
        resumeCursor: getResumeCursor(),
      });
      await Promise.allSettled([...pendingEventHandlers]);
      const activeSession = harnessInstance.adapter
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
      if (runtimeDispatcher.result.response.length === 0) {
        return result;
      }
      const runtimeUsage = runtimeDispatcher.result.usage;
      const hasRuntimeUsage = runtimeUsage.promptTokens > 0
        || runtimeUsage.completionTokens > 0
        || runtimeUsage.cachedTokens > 0
        || runtimeUsage.cost > 0;
      return {
        ...result,
        response: runtimeDispatcher.result.response,
        usage: hasRuntimeUsage ? runtimeUsage : result.usage,
      };
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * Execute the selected app runner/provider harness for one chat turn.
   * @param {{
   *   turn: ChatTurn,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   message: UserMessage,
   *   persona: AgentDefinition | null,
   *   actions: Action[],
   *   actionResolver: (name: string) => Promise<AppAction | null>,
   *   harness: AgentHarness,
   *   harnessInstance: ReturnType<typeof resolveHarnessInstance> | null,
   *   resolvedBinding: ResolvedChatBinding,
   *   keepPresenceAlive: () => Promise<void>,
   *   endPresence: () => Promise<void>,
   *   refreshPresenceLease: () => void,
   * }} input
   * @returns {Promise<{ result: AgentResult, deliveredContentSignatures: Set<string> }>}
   */
  async function runResolvedHarnessTurn({
    turn,
    chatInfo,
    context,
    message,
    persona,
    actions,
    actionResolver,
    harness,
    harnessInstance,
    resolvedBinding,
    keepPresenceAlive,
    endPresence,
    refreshPresenceLease,
  }) {
    const { chatId, senderIds } = turn;
    const runConfig = buildRunConfig(chatId, chatInfo, turn.chatName, harness.getName(), resolvedBinding);
    let currentResumeCursor = chatInfo?.harness_session_kind === harness.getName()
      ? chatInfo.harness_session_id
      : null;
    if (harnessInstance) {
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
        harnessName: harness.getName(),
        instanceId: harnessInstance.instanceId,
        status,
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
      keepPresenceAlive,
      endPresence,
      refreshPresenceLease,
      runConfig.workdir ?? null,
      resolveOutputVisibility(chatInfo?.output_visibility),
      (deliveredContent) => {
        deliveredContentSignatures.add(getDeliveredContentSignature(deliveredContent));
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
    const result = harnessInstance
      ? await runProviderTurnWithRuntimeEvents({
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
            harnessName: harness.getName(),
            runConfig,
            bufferedTexts,
          }),
          getResumeCursor: () => currentResumeCursor,
          saveHarnessSessionAndBinding,
        })
      : await harness.run(await buildHarnessRunRequest({
          chatId,
          senderIds,
          chatInfo,
          chatName: turn.chatName,
          context,
          message,
          persona,
          actions,
          actionResolver,
          llmClient,
          getMessages,
          executeActionFn,
          addMessage,
          updateToolMessage,
          saveHarnessSession: saveHarnessSessionAndBinding,
          hooks,
          harnessName: harness.getName(),
          resolvedBinding,
          bufferedTexts,
        }));
    upsertSessionBinding("ready", undefined);

    return { result, deliveredContentSignatures };
  }

  /**
   * Handle a regular (non-command) message by delegating to the selected harness.
   * @param {{
   *   turn: ChatTurn,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   actions: Action[],
   *   actionResolver: (name: string) => Promise<AppAction | null>,
   *   persona: AgentDefinition | null,
   *   harness: AgentHarness,
   *   harnessInstance: ReturnType<typeof resolveHarnessInstance> | null,
   *   isSlashCommand?: boolean,
   *   resolvedBinding: ResolvedChatBinding,
   * }} input
   * @returns {Promise<ChatTurn | null>}
   */
  async function handleLlmMessage({
    turn,
    chatInfo,
    context,
    actions,
    actionResolver,
    persona,
    harness,
    harnessInstance,
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

    const userText = runCoordinator.hasPendingRun(chatId)
      ? await buildPendingRunInputText({ chatId, chatInfo, content })
      : getTopLevelText(content);
    const lifecycleDecision = await runCoordinator.beginRun({ turn, userText, harness });
    if (lifecycleDecision.status === "buffered") {
      log.debug("Buffered message for pending harness run on chat", chatId);
      return null;
    }
    if (lifecycleDecision.status === "injected") {
      log.debug("Injected message into active harness query for chat", chatId);
      return null;
    }

    /** Start the transport presence lease, swallowing errors. */
    const startPresence = async () => {
      try {
        await turn.io.startPresence(PRESENCE_LEASE_TTL_MS);
      } catch (err) {
        log.debug("Could not start presence lease:", errorToString(err));
      }
    };

    /** Refresh the transport presence lease, swallowing errors. */
    const keepPresenceAlive = async () => {
      try {
        await turn.io.keepPresenceAlive();
      } catch (err) {
        log.debug("Could not refresh presence lease:", errorToString(err));
      }
    };

    /** End the transport presence lease, swallowing errors. */
    const endPresence = async () => {
      try {
        await turn.io.endPresence();
      } catch (err) {
        log.debug("Could not end presence lease:", errorToString(err));
      }
    };

    let presenceRefreshVersion = 0;
    let presenceStopped = false;
    /** Refresh the presence lease in the background without delaying the next harness event. */
    const refreshPresenceLease = () => {
      const refreshVersion = ++presenceRefreshVersion;
      void (async () => {
        if (presenceStopped || refreshVersion !== presenceRefreshVersion) {
          return;
        }
        await keepPresenceAlive();
      })();
    };

    await startPresence();

    /** @type {ChatTurn | null} */
    let nextTurn = null;
    try {
      const { result, deliveredContentSignatures } = await runResolvedHarnessTurn({
        turn,
        chatInfo,
        context,
        message,
        persona,
        actions,
        actionResolver,
        harness,
        harnessInstance,
        resolvedBinding,
        keepPresenceAlive,
        endPresence,
        refreshPresenceLease,
      });
      if (result.response.length > 0) {
        const responseSignature = getDeliveredContentSignature(result.response);
        if (!deliveredContentSignatures.has(responseSignature)) {
          await context.reply(contentEvent("llm", result.response));
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
      presenceStopped = true;
      presenceRefreshVersion += 1;
      await endPresence();
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
    const { persona, harness, harnessInstance } = await resolveConversationHarness(chatInfo);

    const globalActions = await getActionsFn();
    const chatActions = await getChatActions(chatId);
    const chatActionNames = new Set(chatActions.map((action) => action.name));
    const enabledActions = chatInfo?.enabled_actions ?? [];
    /** @type {Action[]} */
    const actions = [
      ...globalActions.filter((action) => !chatActionNames.has(action.name)),
      ...chatActions,
    ].filter((action) => !action.optIn || enabledActions.includes(action.name));

    /** @param {string} name */
    const actionResolver = async (name) => {
      const chatAction = await getChatAction(chatId, name);
      if (chatAction) {
        return chatAction;
      }
      return getAction(name);
    };

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
        actions,
        actionResolver,
        resolvedBinding,
      });
      return null;
    }

    const isSlashCommand = firstBlock?.text?.startsWith("/");
    if (isSlashCommand && firstBlock) {
      if (!chatInfo?.is_enabled) {
        await context.reply(contentEvent("error", `Bot is not enabled in this chat. Use ${formatChatSettingsCommand("enabled on")}`));
        return null;
      }

      const slashCommand = firstBlock.text.slice(1).trim().toLowerCase();
      const handled = await harness.handleCommand({
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
      });
      if (handled) {
        return null;
      }

      log.debug("Slash command not handled by harness; continuing through normal LLM path", slashCommand);
    }

    return handleLlmMessage({
      turn,
      chatInfo,
      context,
      actions,
      actionResolver,
      persona,
      harness,
      harnessInstance,
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
