import { getChatAction, getChatActions, getAction } from "../actions.js";
import { getAgent } from "../agents.js";
import { getRootDb } from "../db.js";
import { storeAndLinkHtml } from "../html-store.js";
import { resolveHarness, resolveHarnessName, createHarnessRunCoordinator } from "../harnesses/index.js";
import {
  shouldRespond,
  formatUserMessage,
  parseCommandArgs,
} from "../message-formatting.js";
import { createMessageActionContext } from "../execute-action-context.js";
import { errorToString, formatTime, isHtmlContent } from "../utils.js";
import { createLogger } from "../logger.js";
import { buildAgentIoHooks } from "./build-agent-io-hooks.js";
import { buildHarnessRunRequest } from "./build-harness-run-request.js";
import { buildRunConfig } from "./build-run-config.js";

const log = createLogger("conversation:runner");

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
 * }} ConversationRunnerDeps
 */

/**
 * Create the conversation runner that owns command dispatch and harness orchestration.
 * @param {ConversationRunnerDeps} deps
 * @returns {{ handleMessage: (turn: ChatTurn) => Promise<void> }}
 */
export function createConversationRunner({ store, llmClient, getActionsFn, executeActionFn }) {
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
  } = store;

  const runCoordinator = createHarnessRunCoordinator();

  /**
   * Handle a `!command` message.
   * @param {{
   *   chatId: string,
   *   senderIds: string[],
   *   content: IncomingContentBlock[],
   *   firstBlock: TextContentBlock,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   actions: Action[],
   *   actionResolver: (name: string) => Promise<AppAction | null>,
   * }} input
   * @returns {Promise<void>}
   */
  async function handleCommandMessage({ chatId, senderIds, content, firstBlock, chatInfo, context, actions, actionResolver }) {
    const inputText = firstBlock.text.slice(1).trim();
    const commandText = inputText.toLowerCase();

    if (commandText === "cancel") {
      const { harness } = await resolveConversationHarness(chatInfo);
      if (harness.cancel?.(chatId)) {
        await context.reply("tool-result", "Cancelled.");
      } else {
        await context.reply("tool-result", "Nothing to cancel.");
      }
      return;
    }

    const commandActions = actions.filter(hasCommand);
    const action = commandActions
      .sort((a, b) => b.command.length - a.command.length)
      .find((candidate) => commandText === candidate.command || commandText.startsWith(candidate.command + " "));

    if (!action) {
      await context.reply("error", `Unknown command: ${commandText.split(" ")[0]}`);
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
        await context.reply("tool-result", linkText);
      } else if (typeof result === "string") {
        await context.reply("tool-result", result);
      } else if (Array.isArray(result)) {
        await context.reply("tool-result", /** @type {ToolContentBlock[]} */ (result));
      } else {
        await context.reply("tool-result", JSON.stringify(result, null, 2));
      }
    } catch (error) {
      log.error("Error executing command:", error);
      await context.reply("error", `Error: ${errorToString(error)}`);
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
   * }} input
   * @returns {Promise<void>}
   */
  async function handleLlmMessage({ turn, chatInfo, context, actions, actionResolver, firstBlock, persona, harness, isSlashCommand }) {
    const { chatId, senderIds, content, senderName, facts } = turn;
    const time = formatTime(turn.timestamp);
    const willRespond = isSlashCommand || shouldRespond(chatInfo, facts);

    let systemPromptSuffix = "";
    if (firstBlock) {
      const formatted = formatUserMessage(firstBlock, facts.isGroup, senderName, time);
      firstBlock.text = formatted.formattedText;
      systemPromptSuffix = formatted.systemPromptSuffix;
    }

    /** @type {UserMessage} */
    const message = { role: "user", content };
    await addMessage(chatId, message, senderIds);

    if (!willRespond) {
      return;
    }

    log.debug("LLM will respond");

    const userText = firstBlock?.text ?? "";
    const lifecycleDecision = runCoordinator.beginRun({ chatId, userText, harness });
    if (lifecycleDecision.status === "buffered") {
      log.debug("Buffered message for pending harness run on chat", chatId);
      return;
    }
    if (lifecycleDecision.status === "injected") {
      log.debug("Injected message into active harness query for chat", chatId);
      return;
    }

    /** Send "composing" presence, swallowing errors. */
    const sendComposing = async () => {
      try {
        await turn.io.setWorking(true);
      } catch (err) {
        log.debug("Could not send composing signal:", errorToString(err));
      }
    };

    await sendComposing();

    try {
      const hooks = buildAgentIoHooks(context, sendComposing, buildRunConfig(chatId, chatInfo).workdir ?? null);
      runCoordinator.markRunActive(chatId);

      const runRequest = await buildHarnessRunRequest({
        chatId,
        senderIds,
        chatInfo,
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
        systemPromptSuffix,
        harnessName: harness.getName(),
        bufferedTexts: runCoordinator.consumeBufferedTexts(chatId),
      });

      await harness.run(runRequest);
    } catch (error) {
      log.error("handleLlmMessage failed:", error);
      const errorMessage = errorToString(error);
      try {
        await context.reply("error", errorMessage);
      } catch {
        // best effort
      }
    } finally {
      runCoordinator.finishRun(chatId);
      try {
        await turn.io.setWorking(false);
      } catch (err) {
        log.debug("Could not send paused signal:", errorToString(err));
      }
    }
  }

  /**
   * Handle one normalized chat turn from the transport.
   * @param {ChatTurn} turn
   * @returns {Promise<void>}
   */
  async function handleMessage(turn) {
    const { chatId, senderIds, content } = turn;

    log.debug("INCOMING MESSAGE:", JSON.stringify(turn, null, 2));

    await createChat(chatId);

    const chatInfo = await getChat(chatId);
    const context = createMessageActionContext(turn);
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

    if (firstBlock?.text?.startsWith("!")) {
      return handleCommandMessage({ chatId, senderIds, content, firstBlock, chatInfo, context, actions, actionResolver });
    }

    const isSlashCommand = firstBlock?.text?.startsWith("/");
    if (isSlashCommand && firstBlock) {
      if (!chatInfo?.is_enabled) {
        await context.reply("error", "Bot is not enabled in this chat. Use !config enabled true");
        return;
      }

      const slashCommand = firstBlock.text.slice(1).trim().toLowerCase();
      const handled = await harness.handleCommand({
        chatId,
        chatInfo,
        context,
        command: slashCommand,
        sessionControl: {
          archive: archiveHarnessSession,
          getHistory: getHarnessSessionHistory,
          restore: restoreHarnessSession,
        },
      });
      if (handled) {
        return;
      }
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
    });
  }

  return { handleMessage };
}
