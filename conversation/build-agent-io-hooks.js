import { MAX_TOOL_CALL_DEPTH, parseToolArgs } from "../agent-io-defaults.js";
import { contentEvent, planEvent, reasoningInspectState, runtimeEvent, subagentMessageEvent, textUpdate, toolCallEvent, usageEvent } from "../outbound-events.js";
import { createCodexDisplayHooks } from "./codex-hook-display.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";

/**
 * File-mutating tool calls are part of change visibility, not just full tool
 * detail progress. Keep them renderable when `toolDetails` is compacted but
 * `changes` remains enabled.
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {((params: Record<string, unknown>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string; startLine?: number } | undefined} toolContext
 * @returns {boolean}
 */
function shouldDisplayToolCallAsChange(toolCall, actionFormatter, cwd, toolContext) {
  void actionFormatter;
  void cwd;
  void toolContext;
  const args = parseToolArgs(toolCall.arguments);
  return (toolCall.name === "Edit" || toolCall.name === "Write") && typeof args.file_path === "string";
}

/**
 * Display a tool call to the user using the formatter shared across harnesses.
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {Pick<ExecuteActionContext, "send">} context
 * @param {((params: Record<string, unknown>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string; startLine?: number } | undefined} toolContext
 * @returns {Promise<MessageHandle | undefined>}
 */
async function displayToolCall(toolCall, context, actionFormatter, cwd, toolContext) {
  const args = parseToolArgs(toolCall.arguments);
  const displaySummary = actionFormatter ? actionFormatter(args) : undefined;
  return context.send(toolCallEvent(toolCall, {
    cwd: cwd ?? null,
    ...(displaySummary !== undefined && { displaySummary }),
    ...(toolContext !== undefined && { context: toolContext }),
  }));
}

/**
 * ACP adapters may emit an empty placeholder tool call named "Editing files"
 * before the actual file-change events. The file-change renderer carries the
 * useful user-facing detail, so keep this transport-only placeholder out of chat.
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @returns {boolean}
 */
function isNoopEditingFilesToolCall(toolCall) {
  if (toolCall.name !== "Editing files") {
    return false;
  }
  const args = parseToolArgs(toolCall.arguments);
  return Object.keys(args).length === 0;
}

/**
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @returns {{ id: string, name: string, arguments: Record<string, unknown> }}
 */
function runtimeToolFromToolCall(toolCall) {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: parseToolArgs(toolCall.arguments),
  };
}

/**
 * Build the AgentIOHooks wiring from a message context.
 * @param {Pick<ExecuteActionContext, "send" | "reply" | "select" | "confirm">} context
 * @param {string | null} cwd
 * @param {import("../chat-output-visibility.js").OutputVisibility} [visibility]
 * @param {(content: SendContent) => void} [recordDeliveredContent]
 * @returns {AgentIOHooks}
 */
export function buildAgentIoHooks(
  context,
  cwd,
  visibility = DEFAULT_OUTPUT_VISIBILITY,
  recordDeliveredContent,
) {
  /**
   * @template T
   * @param {() => Promise<T>} emit
   * @returns {Promise<T>}
   */
  async function emitWhileWorking(emit) {
    return emit();
  }

  const codexDisplayHooks = createCodexDisplayHooks({
    context,
    cwd,
    visibility,
  });
  /** @type {LlmChatResponse["toolCalls"][0][]} */
  const pendingRuntimeToolCalls = [];
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
    onLlmResponse: async (text, metadata) => {
      if (metadata?.streamId && (metadata.streamStatus ?? "partial") !== "final") {
        return;
      }
      /** @type {ToolContentBlock[]} */
      const content = [{ type: "markdown", text }];
      if (metadata?.source === "subagent") {
        if (!visibility.subagents) {
          recordDeliveredContent?.(content);
          return;
        }
        await context.reply(subagentMessageEvent({
          text,
          ...(metadata.threadId !== undefined && { threadId: metadata.threadId }),
          ...(metadata.parentThreadId !== undefined && { parentThreadId: metadata.parentThreadId }),
          ...(metadata.agentNickname !== undefined && { agentNickname: metadata.agentNickname }),
          ...(metadata.agentRole !== undefined && { agentRole: metadata.agentRole }),
        }));
        recordDeliveredContent?.(content);
        return;
      }
      if (metadata?.streamId) {
        await context.reply(contentEvent("llm", content, {
          cwd,
          stream: {
            id: metadata.streamId,
            status: metadata.streamStatus ?? "partial",
          },
        }));
        recordDeliveredContent?.(content);
        return;
      }
      await context.reply(contentEvent("llm", content, { cwd }));
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
      if (isNoopEditingFilesToolCall(toolCall)) {
        return undefined;
      }
      if (!visibility.toolDetails) {
        if (visibility.changes && shouldDisplayToolCallAsChange(toolCall, formatToolCall, cwd, toolContext)) {
          return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
        }
        if (!pendingRuntimeToolCalls.some((pending) => pending.id === toolCall.id)) {
          pendingRuntimeToolCalls.push(toolCall);
          await context.send(runtimeEvent({
            type: "tool.started",
            provider: "codex",
            tool: runtimeToolFromToolCall(toolCall),
          }, { cwd }));
        }
        return undefined;
      }
      return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
    },
    onToolComplete: async (toolCall) => {
      if (!visibility.toolDetails) {
        const index = pendingRuntimeToolCalls.findIndex((pending) => pending.id === toolCall.id);
        if (index !== -1) {
          pendingRuntimeToolCalls.splice(index, 1);
          await context.send(runtimeEvent({
            type: "tool.completed",
            provider: "codex",
            tool: runtimeToolFromToolCall(toolCall),
          }, { cwd }));
        }
      }
    },
    onToolResult: async (blocks) => {
      if (!visibility.toolDetails) {
        return;
      }
      await emitWhileWorking(() => context.send(contentEvent("tool-result", blocks, { cwd })));
      recordDeliveredContent?.(blocks);
    },
    onToolError: async (message) => {
      if (!visibility.toolDetails) {
        const toolCall = pendingRuntimeToolCalls.pop();
        if (toolCall) {
          await context.send(runtimeEvent({
            type: "tool.failed",
            provider: "codex",
            tool: runtimeToolFromToolCall(toolCall),
          }, { cwd }));
          return;
        }
      }
      await emitWhileWorking(() => context.send(contentEvent("error", message)));
    },
    onPlan: async (presentation) => {
      await emitWhileWorking(() => context.reply(planEvent(presentation)));
    },
    onFileChange: async (fileChangeEvent) => {
      await emitWhileWorking(() => codexDisplayHooks.onFileChange(fileChangeEvent));
    },
    onContinuePrompt: () => context.confirm("React 👍 to continue or 👎 to stop."),
    onDepthLimit: () => context.confirm(
      `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
    ),
    onUsage: async (cost, tokens) => {
      await context.send(usageEvent(cost, tokens));
    },
    onRuntimeEvent: async (event) => {
      if (event.type === "file-change.completed") {
        if (!visibility.changes) {
          return;
        }
      }
      await emitWhileWorking(() => context.send(runtimeEvent(event, {
        ...(cwd !== null ? { cwd } : {}),
      })));
    },
  };
}
