import { MAX_TOOL_CALL_DEPTH, parseToolArgs } from "#harnesses";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { contentEvent, planEvent, reasoningInspectState, textUpdate, toolCallEvent, usageEvent } from "../outbound-events.js";
import { createCodexDisplayHooks } from "./codex-hook-display.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";
import { createCompactToolActivityFeed } from "./compact-tool-activity.js";

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
 * @param {() => Promise<void>} keepPresenceAlive
 * @param {() => Promise<void>} endPresence
 * @param {() => void} refreshPresenceLease
 * @param {string | null} cwd
 * @param {import("../chat-output-visibility.js").OutputVisibility} [visibility]
 * @param {(content: SendContent) => void} [recordDeliveredContent]
 * @returns {AgentIOHooks}
 */
export function buildAgentIoHooks(
  context,
  keepPresenceAlive,
  endPresence,
  refreshPresenceLease,
  cwd,
  visibility = DEFAULT_OUTPUT_VISIBILITY,
  recordDeliveredContent,
) {
  /**
   * Refresh the transport presence lease after an outbound progress message without
   * delaying the next harness event. Codex streams events serially, so waiting
   * on the lease refresh here would postpone the following tool-call display.
   * @template T
   * @param {() => Promise<T>} emit
   * @returns {Promise<T>}
   */
  async function emitWhileWorking(emit) {
    const value = await emit();
    refreshPresenceLease();
    return value;
  }

  const codexDisplayHooks = createCodexDisplayHooks({
    context,
    cwd,
    visibility,
    displayToolCall: async (toolCall) => displayToolCall(toolCall, context, undefined, cwd, undefined),
  });
  const compactToolActivity = createCompactToolActivityFeed({
    send: context.send,
    cwd,
  });
  /** @type {MessageHandle | null} */
  let reasoningHandle = null;

  /**
   * @param {{ text?: string, summaryParts: string[], contentParts: string[], hasEncryptedContent?: boolean }} event
   * @returns {string}
   */
  function getReasoningInspectText(event) {
    const text = typeof event.text === "string" && event.text.trim()
      ? event.text.trim()
      : event.contentParts.join("\n").trim() || event.summaryParts.join("\n").trim();
    if (text) {
      return text;
    }
    return event.hasEncryptedContent
      ? "_Codex returned encrypted reasoning, but no public reasoning text._"
      : "_Codex exposed no public reasoning text for this step._";
  }

  return {
    onComposing: keepPresenceAlive,
    onPaused: endPresence,
    onReasoning: async (event) => {
      if (!visibility.thinking) {
        return;
      }
      if (!reasoningHandle) {
        reasoningHandle = await emitWhileWorking(() => context.reply(contentEvent("llm", [{ type: "text", text: "Thinking..." }]))) ?? null;
      }
      if (!reasoningHandle) {
        return;
      }

      const text = getReasoningInspectText(event);
      reasoningHandle.setInspect(reasoningInspectState("*Thinking*", text));

      if (event.status === "completed") {
        await emitWhileWorking(() => reasoningHandle ? reasoningHandle.update(textUpdate("Thought")) : Promise.resolve());
      }
    },
    onLlmResponse: async (text) => {
      await compactToolActivity.close();
      /** @type {ToolContentBlock[]} */
      const content = [{ type: "markdown", text }];
      await context.reply(contentEvent("llm", content));
      recordDeliveredContent?.(content);
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
      if (!visibility.tools) {
        await compactToolActivity.addToolCall(toolCall, formatToolCall, toolContext);
        return undefined;
      }
      return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
    },
    onToolResult: async (blocks) => {
      if (!visibility.tools) {
        return;
      }
      await emitWhileWorking(() => context.send(contentEvent("tool-result", blocks)));
      recordDeliveredContent?.(blocks);
    },
    onToolError: async (message) => {
      if (!visibility.tools) {
        const updated = await compactToolActivity.failMostRecentToolCall();
        if (updated) {
          return;
        }
      }
      await emitWhileWorking(() => context.send(contentEvent("error", message)));
    },
    onCommand: async (commandEvent) => {
      if (!visibility.tools) {
        if (commandEvent.status === "started") {
          await compactToolActivity.addCommand(commandEvent.command);
          return;
        }
        if (commandEvent.status === "completed") {
          await compactToolActivity.completeCommand(commandEvent.command);
          return;
        }
        if (commandEvent.status === "failed") {
          const updated = await compactToolActivity.failCommand(commandEvent.command);
          if (updated) {
            return;
          }
        }
      }
      await emitWhileWorking(() => codexDisplayHooks.onCommand(commandEvent));
    },
    onFileRead: async (fileReadEvent) => {
      if (!visibility.tools) {
        await compactToolActivity.addFileRead(fileReadEvent.command, fileReadEvent.paths);
        return;
      }
      await emitWhileWorking(() => codexDisplayHooks.onFileRead(fileReadEvent));
    },
    onPlan: async (presentation) => {
      await emitWhileWorking(() => context.reply(planEvent(presentation)));
    },
    onFileChange: async (fileChangeEvent) => {
      if (visibility.changes) {
        await compactToolActivity.close();
      }
      await emitWhileWorking(() => codexDisplayHooks.onFileChange(fileChangeEvent));
    },
    onContinuePrompt: () => context.confirm("React 👍 to continue or 👎 to stop."),
    onDepthLimit: () => context.confirm(
      `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
    ),
    onUsage: async (cost, tokens) => { await context.send(usageEvent(cost, tokens)); },
  };
}
