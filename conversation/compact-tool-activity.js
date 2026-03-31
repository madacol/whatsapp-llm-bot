import { parseToolArgs } from "#harnesses";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { contentEvent, textUpdate } from "../outbound-events.js";

const COMPACT_TOOL_ACTIVITY_LIMIT = 3;
const COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS = 1000;

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
 * @param {{
 *   send: Pick<ExecuteActionContext, "send">["send"],
 *   cwd: string | null,
 * }} input
 * @returns {{
 *   addCommand: (command: string) => Promise<void>,
 *   addFileRead: (paths: string[]) => Promise<void>,
 *   addToolCall: (
 *     toolCall: LlmChatResponse["toolCalls"][0],
 *     actionFormatter?: (params: Record<string, unknown>) => string,
 *     toolContext?: { oldContent?: string },
 *   ) => Promise<void>,
 *   close: () => Promise<void>,
 * }}
 */
export function createCompactToolActivityFeed({ send, cwd }) {
  /** @type {MessageHandle | null} */
  let handle = null;
  /** @type {string[]} */
  let lines = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null;

  /**
   * @returns {void}
   */
  function scheduleFlush() {
    if (!handle) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void handle?.update(textUpdate(lines.join("\n")));
    }, COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS);
  }

  /**
   * @param {string} line
   * @returns {Promise<void>}
   */
  async function addLine(line) {
    lines = [...lines, line].slice(-COMPACT_TOOL_ACTIVITY_LIMIT);

    if (!handle) {
      handle = await send(contentEvent("plain", line)) ?? null;
      return;
    }

    scheduleFlush();
  }

  /**
   * Flush the current compact message once, then drop all state so later tool
   * activity starts from a new message.
   * @returns {Promise<void>}
   */
  async function close() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      if (handle) {
        await handle.update(textUpdate(lines.join("\n")));
      }
    }

    handle = null;
    lines = [];
  }

  return {
    addCommand: async (command) => addLine(formatCompactCommand(command)),
    addFileRead: async (paths) => addLine(formatCompactRead(paths)),
    addToolCall: async (toolCall, actionFormatter, toolContext) =>
      addLine(formatCompactToolCall(toolCall, actionFormatter, cwd, toolContext)),
    close,
  };
}
