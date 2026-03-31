import { MAX_TOOL_CALL_DEPTH, parseToolArgs } from "#harnesses";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { contentEvent, planEvent, reasoningInspectState, textUpdate, toolCallEvent, usageEvent } from "../outbound-events.js";
import { createCodexDisplayHooks } from "./codex-hook-display.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";

const COMPACT_TOOL_ACTIVITY_LIMIT = 3;
const COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS = 1000;

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
 * @param {string} command
 * @returns {string}
 */
function formatCompactCommand(command) {
  const lines = command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? "";
  if (!firstLine) {
    return "🔧Bash";
  }
  return `🔧Bash \`${firstLine}\``;
}

/**
 * @param {string[]} paths
 * @returns {string}
 */
function formatCompactRead(paths) {
  const displayPaths = paths
    .filter((path) => typeof path === "string" && path.length > 0)
    .map((path) => `\`${path}\``);
  if (displayPaths.length === 0) {
    return "🔧Read";
  }
  return `🔧Read ${displayPaths.join(", ")}`;
}

/**
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {((params: Record<string, unknown>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string } | undefined} toolContext
 * @returns {string}
 */
function formatCompactToolCall(toolCall, actionFormatter, cwd, toolContext) {
  const args = parseToolArgs(toolCall.arguments);
  if ((toolCall.name === "run_bash" || toolCall.name === "Bash") && typeof args.command === "string") {
    return formatCompactCommand(args.command);
  }
  if (toolCall.name === "exec_command" && typeof args.cmd === "string") {
    return formatCompactCommand(args.cmd);
  }

  const presentation = buildToolPresentation(
    toolCall.name,
    args,
    actionFormatter,
    cwd ?? null,
    toolContext,
  );

  switch (presentation.kind) {
    case "bash":
      return formatCompactCommand(presentation.command);
    case "activity":
      return presentation.activity.lines.length > 0
        ? `🔧${presentation.activity.title} ${presentation.activity.lines.join(", ")}`
        : `🔧${presentation.activity.title}`;
    case "file":
      return `🔧${presentation.toolName} \`${presentation.filePath}\``;
    case "plan":
      return "🔧Plan";
    case "generic":
      return `🔧${presentation.toolName}`;
    default:
      return `🔧${toolCall.name}`;
  }
}

/**
 * Build the AgentIOHooks wiring from a message context.
 * @param {Pick<ExecuteActionContext, "send" | "reply" | "select" | "confirm">} context
 * @param {() => Promise<void>} keepPresenceAlive
 * @param {() => Promise<void>} endPresence
 * @param {() => void} refreshPresenceLease
 * @param {string | null} cwd
 * @param {import("../chat-output-visibility.js").OutputVisibility} [visibility]
 * @returns {AgentIOHooks}
 */
export function buildAgentIoHooks(
  context,
  keepPresenceAlive,
  endPresence,
  refreshPresenceLease,
  cwd,
  visibility = DEFAULT_OUTPUT_VISIBILITY,
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
  /** @type {MessageHandle | null} */
  let reasoningHandle = null;
  /** @type {MessageHandle | null} */
  let compactToolHandle = null;
  /** @type {string[]} */
  let compactToolLines = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let compactToolDebounceTimer = null;

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

  /**
   * @returns {void}
   */
  function scheduleCompactToolFlush() {
    if (!compactToolHandle) {
      return;
    }
    if (compactToolDebounceTimer) {
      clearTimeout(compactToolDebounceTimer);
    }
    compactToolDebounceTimer = setTimeout(() => {
      compactToolDebounceTimer = null;
      void compactToolHandle?.update(textUpdate(compactToolLines.join("\n")));
    }, COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS);
  }

  /**
   * @param {string} line
   * @returns {Promise<void>}
   */
  async function addCompactToolLine(line) {
    compactToolLines = [...compactToolLines, line].slice(-COMPACT_TOOL_ACTIVITY_LIMIT);

    if (!compactToolHandle) {
      compactToolHandle = await context.send(contentEvent("plain", line)) ?? null;
      return;
    }

    scheduleCompactToolFlush();
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
      if (!visibility.tools) {
        await addCompactToolLine(formatCompactToolCall(toolCall, formatToolCall, cwd, toolContext));
        return undefined;
      }
      return displayToolCall(toolCall, context, formatToolCall, cwd, toolContext);
    },
    onToolResult: async (blocks) => {
      if (!visibility.tools) {
        return;
      }
      await emitWhileWorking(() => context.send(contentEvent("tool-result", blocks)));
    },
    onToolError: async (message) => {
      await emitWhileWorking(() => context.send(contentEvent("error", message)));
    },
    onCommand: async (commandEvent) => {
      if (!visibility.tools && commandEvent.status === "started") {
        await addCompactToolLine(formatCompactCommand(commandEvent.command));
        return;
      }
      await emitWhileWorking(() => codexDisplayHooks.onCommand(commandEvent));
    },
    onFileRead: async (fileReadEvent) => {
      if (!visibility.tools) {
        await addCompactToolLine(formatCompactRead(fileReadEvent.paths));
        return;
      }
      await emitWhileWorking(() => codexDisplayHooks.onFileRead(fileReadEvent));
    },
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
