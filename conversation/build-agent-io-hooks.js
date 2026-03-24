import { MAX_TOOL_CALL_DEPTH, parseToolArgs } from "#harnesses";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { contentEvent, planEvent, toolCallEvent, usageEvent } from "../outbound-events.js";
import { createCodexDisplayHooks } from "./codex-hook-display.js";

/**
 * Display a tool call to the user using the formatter shared across harnesses.
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {Pick<ExecuteActionContext, "send">} context
 * @param {((params: Record<string, unknown>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string } | undefined} toolContext
 * @returns {Promise<MessageHandle | undefined>}
 */
async function displayToolCall(toolCall, context, actionFormatter, cwd, toolContext) {
  return context.send(toolCallEvent(
    buildToolPresentation(
      toolCall.name,
      parseToolArgs(toolCall.arguments),
      actionFormatter,
      cwd ?? null,
      toolContext,
    ),
  ));
}

/**
 * Build the AgentIOHooks wiring from a message context.
 * @param {Pick<ExecuteActionContext, "send" | "reply" | "select" | "confirm">} context
 * @param {() => Promise<void>} sendComposing
 * @param {() => Promise<void>} sendPaused
 * @param {() => void} refreshWorking
 * @param {string | null} cwd
 * @returns {AgentIOHooks}
 */
export function buildAgentIoHooks(context, sendComposing, sendPaused, refreshWorking, cwd) {
  /**
   * Refresh WhatsApp typing after an outbound progress message without
   * delaying the next harness event. Codex streams events serially, so waiting
   * on the refresh here would postpone the following tool-call display.
   * @template T
   * @param {() => Promise<T>} emit
   * @returns {Promise<T>}
   */
  async function emitWhileWorking(emit) {
    const value = await emit();
    refreshWorking();
    return value;
  }

  const codexDisplayHooks = createCodexDisplayHooks({
    context,
    cwd,
    displayToolCall: async (toolCall) => displayToolCall(toolCall, context, undefined, cwd, undefined),
  });

  return {
    onComposing: sendComposing,
    onPaused: sendPaused,
    onLlmResponse: async (text) => {
      await context.reply(contentEvent("llm", [{ type: "markdown", text }]));
    },
    onAskUser: async (question, options, _preamble, descriptions) => {
      /** @type {Map<string, string>} */
      const labelMap = new Map();
      const pollOptions = options.map((label, index) => {
        const description = descriptions?.[index];
        const enrichedLabel = description ? `${label}\n\n${description}` : label;
        labelMap.set(enrichedLabel, label);
        return enrichedLabel;
      });

      const choice = await context.select(question || "Choose an option:", pollOptions, {
        deleteOnSelect: true,
      });
      return labelMap.get(choice) ?? choice;
    },
    onToolCall: async (toolCall, formatToolCall, toolContext) => {
      return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
    },
    onToolResult: async (blocks) => {
      await emitWhileWorking(() => context.send(contentEvent("tool-result", blocks)));
    },
    onToolError: async (message) => {
      await emitWhileWorking(() => context.send(contentEvent("error", message)));
    },
    onCommand: async (commandEvent) => { await emitWhileWorking(() => codexDisplayHooks.onCommand(commandEvent)); },
    onFileRead: async (fileReadEvent) => { await emitWhileWorking(() => codexDisplayHooks.onFileRead(fileReadEvent)); },
    onPlan: async (text) => {
      await emitWhileWorking(() => context.reply(planEvent(text)));
    },
    onFileChange: async (fileChangeEvent) => {
      await emitWhileWorking(() => codexDisplayHooks.onFileChange(fileChangeEvent));
    },
    onContinuePrompt: () => context.confirm("React 👍 to continue or 👎 to stop."),
    onDepthLimit: () => context.confirm(
      `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
    ),
    onUsage: async (cost, tokens) => { await context.send(usageEvent(cost, tokens)); },
  };
}
