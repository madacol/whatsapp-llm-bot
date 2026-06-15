import path from "node:path";
import { MAX_TOOL_CALL_DEPTH, parseToolArgs } from "../agent-io-defaults.js";
import { contentEvent, planEvent, reasoningInspectState, runtimeEvent, subagentMessageEvent, textUpdate, toolCallEvent, usageEvent } from "../outbound-events.js";
import { createCodexDisplayHooks } from "./codex-hook-display.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";

export const MAX_AUTO_PRESENTED_SNAPSHOT_FILE_CHANGES = 25;
export const SNAPSHOT_FILE_CHANGE_BATCH_FLUSH_DELAY_MS = 25;
export const REASONING_INSPECT_BATCH_FLUSH_DELAY_MS = process.env.TESTING === "1" ? 0 : 1000;

/**
 * @param {string} filePath
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function formatSnapshotFileChangePath(filePath, cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    return filePath;
  }
  const relativePath = path.relative(path.resolve(cwd), path.resolve(filePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return filePath;
  }
  return relativePath;
}

/**
 * @param {Extract<Parameters<Required<AgentIOHooks>["onRuntimeEvent"]>[0], { type: "file-change.completed" }>[]} events
 * @param {string | null | undefined} cwd
 * @returns {string[]}
 */
function describeSnapshotFileChangeSample(events, cwd) {
  const descriptions = events.slice(0, 10).map((event) => {
    const action = event.change.kind ?? "update";
    return `${action} ${formatSnapshotFileChangePath(event.change.path, cwd)}`;
  });
  if (events.length > descriptions.length) {
    descriptions.push(`... ${events.length - descriptions.length} more`);
  }
  return descriptions;
}

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
  /** @type {Extract<Parameters<Required<AgentIOHooks>["onRuntimeEvent"]>[0], { type: "file-change.completed" }>[]} */
  const pendingSnapshotFileChanges = [];
  /** @type {MessageHandle | null} */
  let reasoningHandle = null;
  /** @type {string[]} */
  const pendingReasoningTraceParts = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reasoningInspectFlushTimer = null;
  /** @type {string | null} */
  let lastReasoningInspectText = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let snapshotFlushTimer = null;

  /**
   * @param {Parameters<Required<AgentIOHooks>["onRuntimeEvent"]>[0]} event
   * @returns {Promise<void>}
   */
  async function sendRuntimePresentationEvent(event) {
    await emitWhileWorking(() => context.send(runtimeEvent(event, {
      ...(cwd !== null ? { cwd } : {}),
    })));
  }

  /**
   * @returns {Promise<void>}
   */
  async function flushSnapshotFileChanges() {
    if (snapshotFlushTimer) {
      clearTimeout(snapshotFlushTimer);
      snapshotFlushTimer = null;
    }
    if (pendingSnapshotFileChanges.length === 0) {
      return;
    }
    const batch = pendingSnapshotFileChanges.splice(0);
    if (batch.length > MAX_AUTO_PRESENTED_SNAPSHOT_FILE_CHANGES) {
      const sample = describeSnapshotFileChangeSample(batch, cwd).join("\n");
      const choice = await context.select(
        `Snapshot detected *${batch.length}* unreported file changes. Send them to chat?\n\n${sample}`,
        ["✅ Continue", "❌ Skip"],
        { deleteOnSelect: true },
      );
      if (!choice.startsWith("✅ Continue")) {
        await sendRuntimePresentationEvent({
          type: "runtime.warning",
          provider: "acp",
          summary: "Snapshot file changes skipped",
          message: `Skipped ${batch.length} unreported snapshot file changes.`,
          details: sample,
          raw: {
            source: "whatsapp.presentation",
            payload: { skippedFileChanges: batch.length },
          },
        });
        return;
      }
    }
    for (const event of batch) {
      await sendRuntimePresentationEvent(event);
    }
  }

  function scheduleSnapshotFileChangeFlush() {
    if (snapshotFlushTimer) {
      clearTimeout(snapshotFlushTimer);
    }
    snapshotFlushTimer = setTimeout(() => {
      void flushSnapshotFileChanges();
    }, SNAPSHOT_FILE_CHANGE_BATCH_FLUSH_DELAY_MS);
    snapshotFlushTimer.unref?.();
  }

  /**
   * @param {{ text?: string, summaryParts: string[], contentParts: string[] }} event
   * @returns {string[]}
   */
  function getReasoningTraceParts(event) {
    const parts = typeof event.text === "string" && event.text.trim()
      ? [event.text.trim()]
      : [...event.contentParts, ...event.summaryParts].map((part) => part.trim()).filter(Boolean);
    return parts.filter((part) => part !== "Thinking...");
  }

  /**
   * @returns {void}
   */
  function flushReasoningInspectBatch() {
    if (reasoningInspectFlushTimer) {
      clearTimeout(reasoningInspectFlushTimer);
      reasoningInspectFlushTimer = null;
    }
    if (!reasoningHandle || pendingReasoningTraceParts.length === 0) {
      return;
    }
    const text = pendingReasoningTraceParts.join("\n\n").trim();
    if (!text || text === lastReasoningInspectText) {
      return;
    }
    lastReasoningInspectText = text;
    reasoningHandle.setInspect(reasoningInspectState("*Thinking*", text));
  }

  /**
   * @returns {void}
   */
  function scheduleReasoningInspectBatchFlush() {
    if (reasoningInspectFlushTimer) {
      clearTimeout(reasoningInspectFlushTimer);
    }
    reasoningInspectFlushTimer = setTimeout(() => {
      flushReasoningInspectBatch();
    }, REASONING_INSPECT_BATCH_FLUSH_DELAY_MS);
    reasoningInspectFlushTimer.unref?.();
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

      const traceParts = getReasoningTraceParts(event);
      if (traceParts.length > 0) {
        pendingReasoningTraceParts.push(...traceParts);
        if (event.status === "completed") {
          flushReasoningInspectBatch();
        } else {
          scheduleReasoningInspectBatchFlush();
        }
      } else if (event.hasEncryptedContent) {
        pendingReasoningTraceParts.push("_Reasoning is encrypted and not available for display._");
        flushReasoningInspectBatch();
      }

      if (event.status === "completed") {
        flushReasoningInspectBatch();
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
        if (event.change.source === "snapshot") {
          pendingSnapshotFileChanges.push(event);
          scheduleSnapshotFileChangeFlush();
          return;
        }
      }
      await flushSnapshotFileChanges();
      await sendRuntimePresentationEvent(event);
    },
  };
}
