import { CANCEL_COMMAND, CHAT_SETTINGS_COMMAND } from "../chat-commands.js";
import { parseCommandArgs } from "../message-formatting.js";
import { tryHandleWorkspaceCommand } from "../workspace-command-router.js";
import { errorToString } from "../utils.js";
import { createAppOutputPort } from "../app-output-port.js";
import { runChatSettingsCommand, CHAT_SETTINGS_COMMAND_PARAMETERS } from "./chat-settings-command.js";
import { runSetupCommand } from "./setup-command.js";
import { createRestartCommandHandler, RESTART_COMMAND_PARAMETERS } from "./restart-command.js";
import { runClearConversationCommand } from "./clear-conversation-command.js";
import { replyCommandError, replyCommandResult } from "./command-results.js";

/**
 * @param {string} inputText
 * @returns {{ name: string, argsText: string, lowered: string }}
 */
function parseBangCommandText(inputText) {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return { name: "", argsText: "", lowered: "" };
  }
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { name: trimmed.toLowerCase(), argsText: "", lowered: trimmed.toLowerCase() };
  }
  return {
    name: trimmed.slice(0, firstSpace).toLowerCase(),
    argsText: trimmed.slice(firstSpace + 1).trim(),
    lowered: trimmed.toLowerCase(),
  };
}

/**
 * @param {string} argsText
 * @param {CommandParametersSchema} parameters
 * @returns {Record<string, string>}
 */
function parseParams(argsText, parameters) {
  const args = argsText ? argsText.split(" ") : [];
  return parseCommandArgs(args, parameters);
}

/**
 * @param {{
 *   workspaceControl: import("../workspace-command-router.js").WorkspaceControl,
 *   addMessage: import("../store.js").Store["addMessage"],
 *   cancelActiveRun: (chatId: string, chatInfo: import("../store.js").ChatRow | undefined) => Promise<boolean>,
 *   clearActiveSession?: (chatId: string, chatInfo: import("../store.js").ChatRow | undefined) => Promise<boolean>,
 *   restartCommandHandler?: ReturnType<typeof createRestartCommandHandler>,
 * }} input
 * @returns {(input: {
 *   turn: ChatTurn,
 *   chatId: string,
 *   senderIds: string[],
 *   content: IncomingContentBlock[],
 *   firstBlock: TextContentBlock,
 *   chatInfo: import("../store.js").ChatRow | undefined,
 *   context: ExecuteActionContext,
 *   resolvedBinding: ResolvedChatBinding,
 * }) => Promise<void>}
 */
export function createBangCommandRouter({
  workspaceControl,
  addMessage,
  cancelActiveRun,
  clearActiveSession,
  restartCommandHandler = createRestartCommandHandler(),
}) {
  return async function handleBangCommand({
    turn,
    chatId,
    senderIds,
    content,
    firstBlock,
    chatInfo,
    context,
    resolvedBinding,
  }) {
    const appOutput = createAppOutputPort(context);
    const inputText = firstBlock.text.slice(1).trim();
    const { name, argsText, lowered } = parseBangCommandText(inputText);

    if (await tryHandleWorkspaceCommand({
      context,
      binding: resolvedBinding,
      inputText,
      workspaceControl,
      seedSourceTurn: {
        senderIds: turn.senderIds,
        senderJids: turn.senderJids,
        senderName: turn.senderName,
      },
    })) {
      return;
    }

    if (lowered === CANCEL_COMMAND) {
      if (await cancelActiveRun(chatId, chatInfo)) {
        await appOutput.replyWithToolResult("Cancelled.");
      } else {
        await appOutput.replyWithToolResult("Nothing to cancel.");
      }
      return;
    }

    /** @type {UserMessage} */
    const commandMessage = { role: "user", content };

    try {
      if (name === CHAT_SETTINGS_COMMAND) {
        await addMessage(chatId, commandMessage, senderIds);
        const result = await runChatSettingsCommand(context, parseParams(argsText, CHAT_SETTINGS_COMMAND_PARAMETERS));
        await replyCommandResult({ chatId, context, result });
        return;
      }

      if (name === "setup") {
        await addMessage(chatId, commandMessage, senderIds);
        const result = await runSetupCommand(context);
        await replyCommandResult({ chatId, context, result });
        return;
      }

      if (name === "restart") {
        await addMessage(chatId, commandMessage, senderIds);
        const command = await restartCommandHandler(context, parseParams(argsText, RESTART_COMMAND_PARAMETERS));
        await replyCommandResult({
          chatId,
          context,
          result: command.result,
          afterResponse: command.afterResponse,
        });
        return;
      }

      if (name === "clear") {
        await addMessage(chatId, commandMessage, senderIds);
        await cancelActiveRun(chatId, chatInfo);
        await clearActiveSession?.(chatId, chatInfo);
        const result = await runClearConversationCommand(context);
        await replyCommandResult({ chatId, context, result });
        return;
      }

      await replyCommandError(context, `Unknown command: ${name || inputText.split(" ")[0]}`);
    } catch (error) {
      await replyCommandError(context, `Error: ${errorToString(error)}`);
    }
  };
}
