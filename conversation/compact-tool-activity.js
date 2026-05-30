import { parseToolArgs } from "../agent-io-defaults.js";
import { buildToolPresentation, shortenPath } from "../tool-presentation-model.js";
import { contentEvent, textUpdate } from "../outbound-events.js";

const COMPACT_TOOL_ACTIVITY_LIMIT = 3;
const COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS = 1000;

/**
 * @param {string} tool
 * @param {string} [detail]
 * @returns {string}
 */
function formatCompactEntry(tool, detail) {
  if (!detail) {
    return `*${tool}*`;
  }
  return detail.startsWith("\n") ? `*${tool}*${detail}` : `*${tool}*  ${detail}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripSimpleMarkdown(value) {
  return value.trim().replace(/^[*_`]+|[*_`]+$/g, "");
}

/**
 * @typedef {{
 *   id: string,
 *   summary: string,
 *   kind?: "command" | "read" | "tool",
 *   inspectDetail?: string,
 *   completed: boolean,
 *   failed: boolean,
 * }} CompactToolActivityEntry
 */

/**
 * @param {CompactToolActivityEntry} entry
 * @returns {string}
 */
function renderCompactEntry(entry) {
  const icon = entry.failed ? "❌" : entry.completed ? "✅" : "🔧";
  return `${icon} ${entry.summary}`;
}

/**
 * @param {CompactToolActivityEntry} entry
 * @returns {string}
 */
function renderInspectEntry(entry) {
  const summary = renderCompactEntry(entry);
  return entry.inspectDetail ? `${summary}\n${entry.inspectDetail}` : summary;
}

/**
 * @param {string} command
 * @returns {string}
 */
function formatCompactCommand(command) {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return formatCompactEntry("Shell");
  }
  if (trimmedCommand.includes("\n")) {
    return formatCompactEntry("Shell", `\n\`\`\`\n${trimmedCommand}\n\`\`\``);
  }
  return formatCompactEntry("Shell", `\`${trimmedCommand}\``);
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
    return formatCompactEntry("Read");
  }
  return formatCompactEntry("Read", displayPaths.join(", "));
}

/**
 * @param {string} value
 * @returns {string}
 */
function boldTarget(value) {
  return `*${value.trim()}*`;
}

/**
 * @param {string} toolName
 * @returns {string | null}
 */
function formatGenericSearchToolName(toolName) {
  const match = toolName.match(/^Search for '(.+)' in (.+)$/);
  if (!match) {
    return null;
  }
  const [, pattern, target] = match;
  if (!pattern || !target) {
    return null;
  }
  return formatCompactEntry("Search", `\`${pattern}\` in ${boldTarget(target)}`);
}

/**
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {string | undefined}
 */
function formatGenericPathDetail(args, cwd) {
  const path = typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : typeof args.filePath === "string"
        ? args.filePath
        : undefined;
  return path ? `\`${shortenPath(path, cwd)}\`` : undefined;
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
function formatGenericToolName(toolName, args, cwd) {
  const search = formatGenericSearchToolName(toolName);
  if (search) {
    return search;
  }
  const pathDetail = formatGenericPathDetail(args, cwd);
  if (!pathDetail && stripSimpleMarkdown(toolName).toLowerCase() === "read file") {
    return null;
  }
  return formatCompactEntry(toolName, pathDetail);
}

/**
 * @param {LlmChatResponse["toolCalls"][0]} toolCall
 * @param {((params: Record<string, unknown>) => string) | undefined} actionFormatter
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string } | undefined} toolContext
 * @returns {string | null}
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
      return formatCompactEntry(
        presentation.activity.title,
        presentation.activity.lines.length > 0 ? presentation.activity.lines.join(", ") : undefined,
      );
    case "file":
      return formatCompactEntry(presentation.toolName, `\`${presentation.filePath}\``);
    case "plan":
      return formatCompactEntry("Plan");
    case "generic": {
      const summary = presentation.summary.trim();
      if (!summary || stripSimpleMarkdown(summary) === stripSimpleMarkdown(presentation.toolName)) {
        return formatGenericToolName(presentation.toolName, args, cwd);
      }
      const detail = !summary.includes("\n")
        ? `\`${summary}\``
        : undefined;
      return detail ? formatCompactEntry(presentation.toolName, detail) : formatGenericToolName(presentation.toolName, args, cwd);
    }
    default:
      return formatCompactEntry(toolCall.name);
  }
}

/**
 * @param {{
 *   send: Pick<ExecuteActionContext, "send">["send"],
 *   cwd: string | null,
 * }} input
 * @returns {{
 *   addCommand: (command: string) => Promise<void>,
 *   completeCommand: (command: string) => Promise<void>,
 *   failCommand: (command: string) => Promise<boolean>,
 *   addFileRead: (command: string, paths: string[]) => Promise<void>,
 *   addToolCall: (
 *     toolCall: LlmChatResponse["toolCalls"][0],
 *     actionFormatter?: (params: Record<string, unknown>) => string,
 *     toolContext?: { oldContent?: string },
 *   ) => Promise<void>,
 *   completeToolCall: (toolCall: LlmChatResponse["toolCalls"][0]) => Promise<boolean>,
 *   failMostRecentToolCall: () => Promise<boolean>,
 *   close: () => Promise<void>,
 * }}
 */
export function createCompactToolActivityFeed({ send, cwd }) {
  /** @type {MessageHandle | null} */
  let handle = null;
  /** @type {CompactToolActivityEntry[]} */
  let entries = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null;
  let nextEntryId = 0;
  /** @type {Map<string, string[]>} */
  const pendingCommandEntryIds = new Map();
  /** @type {string[]} */
  let pendingToolEntryIds = [];
  /** @type {Map<string, string>} */
  const pendingToolEntryIdsByToolId = new Map();

  /**
   * @returns {string}
   */
  function getCompactText() {
    const hiddenCount = Math.max(0, entries.length - COMPACT_TOOL_ACTIVITY_LIMIT);
    const visibleLines = hiddenCount > 0
      ? entries.slice(-COMPACT_TOOL_ACTIVITY_LIMIT)
      : entries;
    return [
      ...(hiddenCount > 0 ? [`... +${hiddenCount} earlier tools`] : []),
      ...visibleLines.map(renderCompactEntry),
    ].join("\n");
  }

  /**
   * @returns {string}
   */
  function getFullText() {
    return entries.map(renderInspectEntry).join("\n");
  }

  /**
   * @returns {void}
   */
  function updateInspectState() {
    handle?.setInspect({
      kind: "text",
      text: getFullText(),
      persistOnInspect: true,
    });
  }

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
      updateInspectState();
      void handle?.update(textUpdate(getCompactText()));
    }, COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS);
  }

  /**
   * @returns {Promise<void>}
   */
  async function flushNow() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (!handle) {
      return;
    }
    updateInspectState();
    await handle.update(textUpdate(getCompactText()));
  }

  /**
   * @param {string} entryId
   * @returns {boolean}
   */
  function markEntryFailed(entryId) {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry || entry.failed) {
      return false;
    }
    entry.failed = true;
    return true;
  }

  /**
   * @param {string} entryId
   * @returns {boolean}
   */
  function markEntryCompleted(entryId) {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry || entry.completed || entry.failed) {
      return false;
    }
    entry.completed = true;
    return true;
  }

  /**
   * @param {string} entryId
   * @returns {void}
   */
  function forgetPendingToolEntry(entryId) {
    pendingToolEntryIds = pendingToolEntryIds.filter((candidate) => candidate !== entryId);
    for (const [toolId, candidateEntryId] of pendingToolEntryIdsByToolId.entries()) {
      if (candidateEntryId === entryId) {
        pendingToolEntryIdsByToolId.delete(toolId);
      }
    }
  }

  /**
   * @param {Map<string, string[]>} map
   * @param {string} key
   * @param {string} entryId
   * @returns {void}
   */
  function rememberPendingEntry(map, key, entryId) {
    const existing = map.get(key) ?? [];
    existing.push(entryId);
    map.set(key, existing);
  }

  /**
   * @param {Map<string, string[]>} map
   * @param {string} key
   * @returns {boolean}
   */
  function hasPendingEntry(map, key) {
    const existing = map.get(key);
    return Array.isArray(existing) && existing.length > 0;
  }

  /**
   * @param {Map<string, string[]>} map
   * @param {string} key
   * @returns {string | undefined}
   */
  function consumePendingEntry(map, key) {
    const existing = map.get(key);
    if (!existing || existing.length === 0) {
      return undefined;
    }
    const entryId = existing.shift();
    if (existing.length === 0) {
      map.delete(key);
    }
    return entryId;
  }

  /**
   * @param {CompactToolActivityEntry} entry
   * @returns {Promise<void>}
   */
  async function addEntry(entry) {
    entries.push(entry);

    if (!handle) {
      handle = await send(contentEvent("plain", getCompactText())) ?? null;
      updateInspectState();
      return;
    }

    updateInspectState();
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
        updateInspectState();
        await handle.update(textUpdate(getCompactText()));
      }
    }

    handle = null;
    entries = [];
    pendingCommandEntryIds.clear();
    pendingToolEntryIds = [];
    pendingToolEntryIdsByToolId.clear();
  }

  return {
    addCommand: async (command) => {
      if (hasPendingEntry(pendingCommandEntryIds, command)) {
        return;
      }
      const entryId = `compact-entry-${++nextEntryId}`;
      rememberPendingEntry(pendingCommandEntryIds, command, entryId);
      await addEntry({
        id: entryId,
        summary: formatCompactCommand(command),
        kind: "command",
        completed: false,
        failed: false,
      });
    },
    completeCommand: async (command) => {
      const entryId = consumePendingEntry(pendingCommandEntryIds, command);
      if (!entryId || !markEntryCompleted(entryId)) {
        return;
      }
      await flushNow();
    },
    failCommand: async (command) => {
      const entryId = consumePendingEntry(pendingCommandEntryIds, command);
      if (!entryId || !markEntryFailed(entryId)) {
        return false;
      }
      await flushNow();
      return true;
    },
    addFileRead: async (command, paths) => {
      if (hasPendingEntry(pendingCommandEntryIds, command)) {
        return;
      }
      const entryId = `compact-entry-${++nextEntryId}`;
      rememberPendingEntry(pendingCommandEntryIds, command, entryId);
      await addEntry({
        id: entryId,
        summary: formatCompactRead(paths),
        kind: "read",
        completed: false,
        failed: false,
      });
    },
    addToolCall: async (toolCall, actionFormatter, toolContext) => {
      if (pendingToolEntryIdsByToolId.has(toolCall.id)) {
        return;
      }
      const summary = formatCompactToolCall(toolCall, actionFormatter, cwd, toolContext);
      if (!summary) {
        return;
      }
      const entryId = `compact-entry-${++nextEntryId}`;
      pendingToolEntryIds.push(entryId);
      pendingToolEntryIdsByToolId.set(toolCall.id, entryId);
      await addEntry({
        id: entryId,
        summary,
        kind: "tool",
        completed: false,
        failed: false,
      });
    },
    completeToolCall: async (toolCall) => {
      const entryId = pendingToolEntryIdsByToolId.get(toolCall.id);
      if (!entryId || !markEntryCompleted(entryId)) {
        return false;
      }
      forgetPendingToolEntry(entryId);
      await flushNow();
      return true;
    },
    failMostRecentToolCall: async () => {
      while (pendingToolEntryIds.length > 0) {
        const entryId = pendingToolEntryIds.pop();
        if (typeof entryId !== "string" || !markEntryFailed(entryId)) {
          continue;
        }
        forgetPendingToolEntry(entryId);
        await flushNow();
        return true;
      }
      return false;
    },
    close,
  };
}
