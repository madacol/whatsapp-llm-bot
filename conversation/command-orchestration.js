import { formatChatSettingsCommand } from "../chat-commands.js";
import { createAppOutputPort } from "../app-output-port.js";
import { createBangCommandRouter } from "../commands/bang-command-router.js";
import { runClearConversationCommand } from "../commands/clear-conversation-command.js";
import { handleSlashDiffCommand } from "../slash-diff-command.js";
import { buildClearCommandFollowUp } from "./clear-command-follow-up.js";

/**
 * @typedef {{ kind: "handled", followUpTurn: ChannelInput | null } | { kind: "unhandled" }} CommandOrchestrationResult
 * @typedef {ReturnType<typeof import("./agent-runtime.js").createAgentRuntime>} AgentRuntime
 * @typedef {Awaited<ReturnType<AgentRuntime["resolveSelection"]>>} AgentRuntimeSelection
 */

/**
 * @param {{
 *   addMessage: import("../store.js").Store["addMessage"],
 *   workspaceControl: import("../workspace-command-router.js").WorkspaceControl,
 *   restartCommandHandler?: ReturnType<typeof import("../commands/restart-command.js").createRestartCommandHandler>,
 *   agentRuntime: Pick<AgentRuntime, "cancelActiveRun" | "clearActiveSession" | "resolveSelection" | "resolveWorkdir" | "handleCommand">,
 * }} input
 */
export function createCommandOrchestration({
  addMessage,
  workspaceControl,
  restartCommandHandler,
  agentRuntime,
}) {
  const bangCommandRouter = createBangCommandRouter({
    workspaceControl,
    addMessage,
    restartCommandHandler,
    cancelActiveRun: agentRuntime.cancelActiveRun,
    clearActiveSession: agentRuntime.clearActiveSession,
  });

  /**
   * @param {{
   *   turn: ChannelInput,
   *   firstBlock: TextContentBlock,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   resolvedBinding: ResolvedChatBinding,
   * }} input
   * @returns {Promise<CommandOrchestrationResult>}
   */
  async function handleBangCommand({ turn, firstBlock, chatInfo, context, resolvedBinding }) {
    const clearFollowUp = buildClearCommandFollowUp(turn, firstBlock, "!");
    await bangCommandRouter({
      turn,
      chatId: turn.chatId,
      senderIds: turn.senderIds,
      content: turn.content,
      firstBlock,
      chatInfo,
      context,
      resolvedBinding,
    });
    return { kind: "handled", followUpTurn: clearFollowUp?.followUpTurn ?? null };
  }

  /**
   * @param {{
   *   turn: ChannelInput,
   *   firstBlock: TextContentBlock,
   *   chatInfo: import("../store.js").ChatRow | undefined,
   *   context: ExecuteActionContext,
   *   resolvedBinding: ResolvedChatBinding,
   * }} input
   * @returns {Promise<CommandOrchestrationResult>}
   */
  async function handleSlashCommand({ turn, firstBlock, chatInfo, context, resolvedBinding }) {
    const appOutput = createAppOutputPort(context);
    const clearFollowUp = buildClearCommandFollowUp(turn, firstBlock, "/");
    const slashCommand = clearFollowUp
      ? "clear"
      : firstBlock.text.slice(1).trim().toLowerCase();
    const selection = await agentRuntime.resolveSelection(chatInfo);

    if (slashCommand === "diff" || slashCommand.startsWith("diff ")) {
      const slashWorkdir = agentRuntime.resolveWorkdir({
        chatId: turn.chatId,
        chatInfo,
        chatName: turn.chatName,
        selection,
        resolvedBinding,
      });
      if (!slashWorkdir) {
        await appOutput.replyWithError("Could not resolve a workdir for `/diff`.");
        return { kind: "handled", followUpTurn: null };
      }
      const handledSlashDiff = await handleSlashDiffCommand({
        command: slashCommand,
        workdir: slashWorkdir,
        context,
      });
      if (handledSlashDiff) {
        return { kind: "handled", followUpTurn: null };
      }
    }

    const handled = await agentRuntime.handleCommand({
      selection,
      chatId: turn.chatId,
      chatInfo,
      context,
      command: slashCommand,
    });
    if (handled) {
      if (clearFollowUp) {
        await runClearConversationCommand(context);
      }
      return { kind: "handled", followUpTurn: clearFollowUp?.followUpTurn ?? null };
    }

    if (!clearFollowUp) {
      return { kind: "unhandled" };
    }

    await agentRuntime.clearActiveSession?.(turn.chatId, chatInfo);
    const result = await runClearConversationCommand(context);
    if (result !== "Conversation history cleared.") {
      await appOutput.replyWithToolResult(result);
      return { kind: "handled", followUpTurn: null };
    }
    await appOutput.replyWithToolResult("Session cleared\n\nNext message starts fresh.");
    return { kind: "handled", followUpTurn: clearFollowUp.followUpTurn };
  }

  return {
    /**
     * @param {{
     *   route: Extract<import("./channel-input-routing.js").ChannelInputRouteDecision, { type: "bang-command" | "slash-command" | "disabled-slash-command" }>,
     *   turn: ChannelInput,
     *   chatInfo: import("../store.js").ChatRow | undefined,
     *   context: ExecuteActionContext,
     *   resolvedBinding: ResolvedChatBinding,
     * }} input
     * @returns {Promise<CommandOrchestrationResult>}
     */
    async handleCommand({ route, turn, chatInfo, context, resolvedBinding }) {
      const firstBlock = turn.content.find((block) => block.type === "text");
      if (!firstBlock) {
        return { kind: "unhandled" };
      }

      if (route.type === "disabled-slash-command") {
        await createAppOutputPort(context).replyWithError(
          `Bot is not enabled in this chat. Use ${formatChatSettingsCommand("enabled on")}`,
        );
        return { kind: "handled", followUpTurn: null };
      }

      if (route.type === "bang-command") {
        return handleBangCommand({ turn, firstBlock, chatInfo, context, resolvedBinding });
      }

      return handleSlashCommand({ turn, firstBlock, chatInfo, context, resolvedBinding });
    },
  };
}
