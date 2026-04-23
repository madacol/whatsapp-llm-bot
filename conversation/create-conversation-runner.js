import { CANCEL_COMMAND, formatChatSettingsCommand } from "../chat-commands.js";
import { getChatAction, getChatActions, getAction } from "../actions.js";
import { getAgent } from "../agents.js";
import { getRootDb } from "../db.js";
import { storeAndLinkHtml } from "../html-store.js";
import { resolveHarness, resolveHarnessName, createHarnessRunCoordinator } from "#harnesses";
import { contentEvent } from "../outbound-events.js";
import {
  shouldRespond,
  parseCommandArgs,
} from "../message-formatting.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { errorToString, isHtmlContent } from "../utils.js";
import { createLogger } from "../logger.js";
import { buildAgentIoHooks } from "./build-agent-io-hooks.js";
import { buildHarnessRunRequest } from "./build-harness-run-request.js";
import { buildRunConfig } from "./build-run-config.js";
import { generateSessionTitle } from "./session-title.js";
import { resolveOutputVisibility } from "../chat-output-visibility.js";
import { createWorkspaceBindingService } from "../workspace-binding-service.js";
import { tryHandleWorkspaceCommand } from "../workspace-command-router.js";
import { createWorkspaceControl } from "../workspace-control.js";
import { createWorkspaceLifecycleService } from "../workspace-lifecycle-service.js";

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
 * @param {SlashCommandDescriptor[]} commands
 * @returns {string}
 */
function formatAvailableSlashCommands(commands) {
  return commands
    .map((command) => `/${command.name} - ${command.description}`)
    .join("\n");
}

/**
 * @param {SendContent} content
 * @returns {string}
 */
function getDeliveredContentSignature(content) {
  return JSON.stringify(content);
}

/**
 * Resolve the persona and harness for the current chat.
 * @param {import("../store.js").ChatRow | undefined} chatInfo
 * @returns {Promise<{ persona: AgentDefinition | null, harness: AgentHarness }>}
 */
async function resolveConversationHarness(chatInfo) {
  const persona = chatInfo?.active_persona
    ? await getAgent(chatInfo.active_persona)
    : null;
  const harnessName = resolveHarnessName(persona, chatInfo);
  return {
    persona,
    harness: resolveHarness(harnessName),
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
 * }} ConversationRunnerDeps
 */

/**
 * Create the conversation runner that owns command dispatch and harness orchestration.
 * @param {ConversationRunnerDeps} deps
 * @returns {{ handleMessage: (turn: ChatTurn) => Promise<void> }}
 */
export function createConversationRunner({ store, llmClient, getActionsFn, executeActionFn, workspacePresentation }) {
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
  const workspaceBinding = createWorkspaceBindingService(store);
  const workspaceControl = createWorkspaceControl({ store, workspacePresentation });
  const workspaceLifecycle = createWorkspaceLifecycleService({
    workspaceControl,
    workspacePresentation,
    dispatchTurn,
  });

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
      const { result } = await executeActionFn(action.name, context, params, { actionResolver, llmClient });

      if (isHtmlContent(result)) {
        const linkText = await storeAndLinkHtml(getRootDb(), result);
        await context.reply(contentEvent("tool-result", linkText));
      } else if (typeof result === "string") {
        await context.reply(contentEvent("tool-result", result));
      } else if (Array.isArray(result)) {
        await context.reply(contentEvent("tool-result", /** @type {ToolContentBlock[]} */ (result)));
      } else {
        await context.reply(contentEvent("tool-result", JSON.stringify(result, null, 2)));
      }
    } catch (error) {
      log.error("Error executing command:", error);
      await context.reply(contentEvent("error", `Error: ${errorToString(error)}`));
    }
  }

  /**
   * Handle a regular (non-command) message by delegating to the selected harness.
   * @param {{
   *   turn: ChatTurn,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   actions: Action[],
   *   actionResolver: (name: string) => Promise<AppAction | null>,
 *   firstBlock: TextContentBlock | undefined,
 *   persona: AgentDefinition | null,
 *   harness: AgentHarness,
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
    firstBlock,
    persona,
    harness,
    isSlashCommand,
    resolvedBinding,
  }) {
    const { chatId, senderIds, content, senderName, facts } = turn;
    const willRespond = isSlashCommand || shouldRespond(chatInfo, facts);

    let userText = firstBlock?.text ?? "";

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

    const lifecycleDecision = runCoordinator.beginRun({ turn, userText, harness });
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
    /** @type {Set<string>} */
    const deliveredContentSignatures = new Set();

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
      const runConfig = buildRunConfig(chatId, chatInfo, turn.chatName, harness.getName(), resolvedBinding);
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

      const runRequest = await buildHarnessRunRequest({
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
        saveHarnessSession,
        hooks,
        harnessName: harness.getName(),
        resolvedBinding,
        bufferedTexts: runCoordinator.consumeBufferedTexts(chatId),
      });

      const result = await harness.run(runRequest);
      if (result.response.length > 0) {
        const responseSignature = getDeliveredContentSignature(result.response);
        if (!deliveredContentSignatures.has(responseSignature)) {
          await context.reply(contentEvent("llm", result.response));
        }
      }
    } catch (error) {
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
    const { persona, harness } = await resolveConversationHarness(chatInfo);

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

      const availableSlashCommands = harness.listSlashCommands();
      const slashCommandName = firstBlock.text.split(/\s+/, 1)[0] ?? "/";
      await context.reply(contentEvent(
        "tool-result",
        `Unknown slash command: ${slashCommandName}\nAvailable slash commands:\n${formatAvailableSlashCommands(availableSlashCommands)}`,
      ));
      return null;
    }

    return handleLlmMessage({
      turn,
      chatInfo,
      context,
      actions,
      actionResolver,
      firstBlock,
      persona,
      harness,
      isSlashCommand: !!isSlashCommand,
      resolvedBinding,
    });
  }

  return {
    async handleMessage(turn) {
      await dispatchTurn(turn);
    },
  };
}
