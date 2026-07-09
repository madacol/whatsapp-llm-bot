import path from "node:path";
import { MAX_TOOL_CALL_DEPTH, parseToolArgs } from "../agent-io-defaults.js";
import { reasoningInspectState, textUpdate } from "../message-handle-events.js";
import { createAgentRunOutputPort } from "../agent-run-output-port.js";
import { createCodexDisplayHooks } from "./codex-hook-display.js";
import { DEFAULT_OUTPUT_VISIBILITY, resolveOutputVisibility } from "../chat-output-visibility.js";

export const MAX_AUTO_PRESENTED_SNAPSHOT_FILE_CHANGES = 25;
export const SNAPSHOT_FILE_CHANGE_BATCH_FLUSH_DELAY_MS = 25;

/**
 * @typedef {import("../chat-output-visibility.js").OutputVisibility | import("../chat-output-visibility.js").OutputVisibilityOverrides} OutputVisibilityValue
 * @typedef {OutputVisibilityValue | (() => OutputVisibilityValue | Promise<OutputVisibilityValue>)} OutputVisibilityInput
 */

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
 * detail progress. Keep them renderable when tool output is compact but file
 * changes remain enabled.
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
 * @param {Pick<ExecuteActionContext, "send" | "reply">} context
 * @param {((params: Record<string, unknown>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string; startLine?: number } | undefined} toolContext
 * @returns {Promise<MessageHandle | undefined>}
 */
async function displayToolCall(toolCall, context, actionFormatter, cwd, toolContext) {
  const args = parseToolArgs(toolCall.arguments);
  const displaySummary = actionFormatter ? actionFormatter(args) : undefined;
  return createAgentRunOutputPort(context, { cwd }).sendToolCall(toolCall, {
    cwd: cwd ?? null,
    ...(displaySummary !== undefined && { displaySummary }),
    ...(toolContext !== undefined && { context: toolContext }),
  });
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
 * @param {OutputVisibilityInput} [visibility]
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
   * @returns {Promise<import("../chat-output-visibility.js").OutputVisibility>}
   */
  async function getOutputVisibility() {
    const raw = typeof visibility === "function" ? await visibility() : visibility;
    return resolveOutputVisibility(raw);
  }

  const agentOutput = createAgentRunOutputPort(context, { cwd });
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
    getVisibility: getOutputVisibility,
  });
  /** @type {{ id: string, visibility: import("../chat-output-visibility.js").OutputVisibility }[]} */
  const activeToolItems = [];
  /** @type {{ toolCall: LlmChatResponse["toolCalls"][0], visibility: import("../chat-output-visibility.js").OutputVisibility }[]} */
  const pendingRuntimeToolCalls = [];
  /** @type {Extract<Parameters<Required<AgentIOHooks>["onRuntimeEvent"]>[0], { type: "file-change.completed" }>[]} */
  const pendingSnapshotFileChanges = [];
  /** @type {MessageHandle | null} */
  let reasoningHandle = null;
  let pendingEncryptedReasoning = false;
  let reasoningInspectAttached = false;
  let reasoningFinalized = false;
  let pinnedReasoningShown = false;
  /** @type {import("../chat-output-visibility.js").OutputVisibility | null} */
  let activeReasoningVisibility = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let snapshotFlushTimer = null;

  function resetReasoningItemState() {
    reasoningHandle = null;
    pendingEncryptedReasoning = false;
    reasoningInspectAttached = false;
    reasoningFinalized = false;
    pinnedReasoningShown = false;
    activeReasoningVisibility = null;
  }

  /**
   * @param {Parameters<Required<AgentIOHooks>["onRuntimeEvent"]>[0]} event
   * @returns {Promise<void>}
   */
  async function sendRuntimePresentationEvent(event) {
    await emitWhileWorking(() => agentOutput.sendRuntimeEvent(event));
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
    return parts;
  }

  /**
   * @param {{ text?: string, summaryParts: string[], contentParts: string[], hasEncryptedContent?: boolean }} event
   * @returns {string}
   */
  function getCompletedReasoningText(event) {
    const traceParts = getReasoningTraceParts(event);
    return traceParts.length > 0
      ? traceParts.join("\n\n").trim()
      : (pendingEncryptedReasoning || event.hasEncryptedContent === true
        ? "_Reasoning is encrypted and not available for display._"
        : "");
  }

  /**
   * @param {{ text?: string, summaryParts: string[], contentParts: string[], hasEncryptedContent?: boolean }} event
   * @returns {boolean}
   */
  function attachCompletedReasoningInspect(event) {
    if (!reasoningHandle || reasoningInspectAttached) {
      return false;
    }
    const text = getCompletedReasoningText(event);
    if (!text) {
      return false;
    }
    reasoningInspectAttached = true;
    reasoningHandle.setInspect(reasoningInspectState("*Thought*", text));
    return true;
  }

  /**
   * @param {{ text?: string, summaryParts: string[], contentParts: string[], hasEncryptedContent?: boolean }} event
   * @returns {boolean}
   */
  function shouldCreateReasoningHandle(event) {
    return event.hasEncryptedContent === true || getReasoningTraceParts(event).length > 0;
  }

  /**
   * @param {{ status: string }} event
   * @returns {Promise<void>}
   */
  async function emitPinnedReasoningIndicator(event) {
    if (pinnedReasoningShown || event.status === "completed") {
      return;
    }
    pinnedReasoningShown = true;
    await sendRuntimePresentationEvent({
      type: "reasoning.updated",
      provider: "llm",
      status: "updated",
      text: "",
      summaryParts: [],
      contentParts: [],
    });
  }

  /**
   * @param {{ status: string, text?: string, summaryParts: string[], contentParts: string[], hasEncryptedContent?: boolean }} event
   * @returns {Promise<void>}
   */
  async function emitCompletedReasoningDetails(event) {
    if (event.status !== "completed") {
      return;
    }
    const text = getCompletedReasoningText(event);
    if (!text) {
      return;
    }
    await emitWhileWorking(() => agentOutput.replyWithAssistantOutput([{
      type: "markdown",
      text: `*Thought*\n\n${text}`,
    }]));
  }

  /**
   * @param {string} id
   * @param {import("../chat-output-visibility.js").OutputVisibility} visibility
   */
  function rememberActiveToolItem(id, visibility) {
    if (!activeToolItems.some((item) => item.id === id)) {
      activeToolItems.push({ id, visibility });
    }
  }

  /**
   * @param {string} id
   * @returns {{ id: string, visibility: import("../chat-output-visibility.js").OutputVisibility } | undefined}
   */
  function forgetActiveToolItem(id) {
    const index = activeToolItems.findIndex((item) => item.id === id);
    if (index === -1) {
      return undefined;
    }
    return activeToolItems.splice(index, 1)[0];
  }

  /**
   * @returns {Promise<import("../chat-output-visibility.js").OutputVisibility>}
   */
  async function resolveToolResultVisibility() {
    const activeItem = activeToolItems.shift();
    if (!activeItem) {
      return getOutputVisibility();
    }
    return activeItem.visibility;
  }

  return {
    onReasoning: async (event) => {
      if (reasoningFinalized && event.status !== "completed") {
        resetReasoningItemState();
      }
      const outputVisibility = activeReasoningVisibility ?? await getOutputVisibility();
      activeReasoningVisibility = outputVisibility;
      if (outputVisibility.reasoning === "hidden") {
        if (event.status === "completed") {
          reasoningFinalized = true;
        }
        return;
      }
      if (outputVisibility.reasoning === "pinnedIndicator") {
        await emitPinnedReasoningIndicator(event);
        if (event.status === "completed") {
          reasoningFinalized = true;
        }
        return;
      }
      if (outputVisibility.reasoning === "fullDetails") {
        await emitCompletedReasoningDetails(event);
        if (event.status === "completed") {
          reasoningFinalized = true;
        }
        return;
      }
      if (!reasoningHandle) {
        if (event.status === "completed" && !shouldCreateReasoningHandle(event)) {
          return;
        }
        reasoningHandle = await emitWhileWorking(() => agentOutput.replyWithThinking()) ?? null;
      }
      if (!reasoningHandle) {
        return;
      }

      if (event.hasEncryptedContent) {
        pendingEncryptedReasoning = true;
      }

      if (event.status === "completed") {
        attachCompletedReasoningInspect(event);
        if (!reasoningFinalized) {
          reasoningFinalized = true;
          await emitWhileWorking(() => reasoningHandle ? reasoningHandle.update(textUpdate("Thought")) : Promise.resolve());
        }
      }
    },
    onLlmResponse: async (text, metadata) => {
      if (metadata?.streamId && (metadata.streamStatus ?? "partial") !== "final") {
        return;
      }
      const outputVisibility = await getOutputVisibility();
      /** @type {ToolContentBlock[]} */
      const content = [{ type: "markdown", text }];
      if (metadata?.source === "subagent") {
        if (outputVisibility.subagents === "hidden") {
          recordDeliveredContent?.(content);
          return;
        }
        await agentOutput.replyWithSubagentMessage({
          text,
          ...(metadata.threadId !== undefined && { threadId: metadata.threadId }),
          ...(metadata.parentThreadId !== undefined && { parentThreadId: metadata.parentThreadId }),
          ...(metadata.agentNickname !== undefined && { agentNickname: metadata.agentNickname }),
          ...(metadata.agentRole !== undefined && { agentRole: metadata.agentRole }),
        });
        recordDeliveredContent?.(content);
        return;
      }
      if (metadata?.streamId && outputVisibility.middleAssistantMessages === "off") {
        return;
      }
      if (metadata?.streamId) {
        await agentOutput.replyWithAssistantOutput(content, {
          stream: {
            id: metadata.streamId,
            status: metadata.streamStatus ?? "partial",
          },
        });
        recordDeliveredContent?.(content);
        return;
      }
      await agentOutput.replyWithAssistantOutput(content);
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
      const outputVisibility = await getOutputVisibility();
      rememberActiveToolItem(toolCall.id, outputVisibility);
      if (outputVisibility.tools === "hidden") {
        return undefined;
      }
      if (outputVisibility.tools !== "fullDetails") {
        if (outputVisibility.fileChanges === "shown" && shouldDisplayToolCallAsChange(toolCall, formatToolCall, cwd, toolContext)) {
          return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
        }
        if (!pendingRuntimeToolCalls.some((pending) => pending.toolCall.id === toolCall.id)) {
          pendingRuntimeToolCalls.push({ toolCall, visibility: outputVisibility });
          await agentOutput.sendRuntimeEvent({
            type: "tool.started",
            provider: "codex",
            tool: runtimeToolFromToolCall(toolCall),
          });
        }
        return undefined;
      }
      return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
    },
    onToolComplete: async (toolCall) => {
      const index = pendingRuntimeToolCalls.findIndex((pending) => pending.toolCall.id === toolCall.id);
      if (index === -1) {
        forgetActiveToolItem(toolCall.id);
        return;
      }
      const [pending] = pendingRuntimeToolCalls.splice(index, 1);
      forgetActiveToolItem(toolCall.id);
      if (!pending || pending.visibility.tools === "hidden" || pending.visibility.tools === "fullDetails") {
        return;
      }
      await agentOutput.sendRuntimeEvent({
        type: "tool.completed",
        provider: "codex",
        tool: runtimeToolFromToolCall(toolCall),
      });
    },
    onToolResult: async (blocks) => {
      const outputVisibility = await resolveToolResultVisibility();
      if (outputVisibility.tools !== "fullDetails") {
        return;
      }
      await emitWhileWorking(() => agentOutput.sendToolResult(blocks));
      recordDeliveredContent?.(blocks);
    },
    onToolError: async (message) => {
      const pending = pendingRuntimeToolCalls.pop();
      const activeItem = pending ? forgetActiveToolItem(pending.toolCall.id) : activeToolItems.pop();
      if (pending && pending.visibility.tools !== "hidden" && pending.visibility.tools !== "fullDetails") {
        await agentOutput.sendRuntimeEvent({
          type: "tool.failed",
          provider: "codex",
          tool: runtimeToolFromToolCall(pending.toolCall),
        });
        return;
      }
      const outputVisibility = activeItem?.visibility ?? await getOutputVisibility();
      if (outputVisibility.tools === "hidden") {
        return;
      }
      await emitWhileWorking(() => agentOutput.sendError(message));
    },
    onPlan: async (presentation) => {
      const outputVisibility = await getOutputVisibility();
      if (outputVisibility.plans === "hidden") {
        return;
      }
      await emitWhileWorking(() => agentOutput.replyWithPlan(presentation));
    },
    onFileChange: async (fileChangeEvent) => {
      await emitWhileWorking(() => codexDisplayHooks.onFileChange(fileChangeEvent));
    },
    onContinuePrompt: () => context.confirm("React 👍 to continue or 👎 to stop."),
    onDepthLimit: () => context.confirm(
      `⚠️ *Depth limit*\n\nReached maximum tool call depth (${MAX_TOOL_CALL_DEPTH}). React 👍 to continue or 👎 to stop.`,
    ),
    onUsage: async (cost, tokens) => {
      const outputVisibility = await getOutputVisibility();
      if (outputVisibility.usage === "hidden") {
        return;
      }
      await agentOutput.sendUsage(cost, tokens);
    },
    onRuntimeEvent: async (event) => {
      const outputVisibility = await getOutputVisibility();
      if (event.type === "file-change.completed") {
        if (event.change.source === "snapshot") {
          if (outputVisibility.snapshots === "off") {
            return;
          }
          pendingSnapshotFileChanges.push(event);
          scheduleSnapshotFileChangeFlush();
          return;
        }
        if (outputVisibility.fileChanges === "hidden") {
          return;
        }
      }
      await flushSnapshotFileChanges();
      await sendRuntimePresentationEvent(event);
    },
  };
}
