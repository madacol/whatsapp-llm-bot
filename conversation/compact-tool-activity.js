import { parseToolArgs } from "#harnesses";
import { buildToolPresentation } from "../tool-presentation-model.js";
import { contentEvent, textUpdate } from "../outbound-events.js";

const COMPACT_TOOL_ACTIVITY_LIMIT = 3;
const COMPACT_TOOL_ACTIVITY_DEBOUNCE_MS = 1000;

/**
 * @param {string} tool
 * @param {string} [detail]
 * @returns {string}
 */
function formatCompactEntry(tool, detail) {
  return detail ? `*${tool}*  ${detail}` : `*${tool}*`;
}

/**
 * @typedef {{
 *   id: string,
 *   summary: string,
 *   failed: boolean,
 * }} CompactToolActivityEntry
 */

/**
 * @param {CompactToolActivityEntry} entry
 * @returns {string}
 */
function renderCompactEntry(entry) {
  return `${entry.failed ? "❌" : "🔧"} ${entry.summary}`;
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
    return formatCompactEntry("Bash");
  }
  return formatCompactEntry("Bash", `\`${firstLine}\``);
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
      const detail = summary && summary !== presentation.toolName && !summary.includes("\n")
        ? `\`${summary}\``
        : undefined;
      return formatCompactEntry(presentation.toolName, detail);
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
    return entries.map(renderCompactEntry).join("\n");
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
  }

  return {
    addCommand: async (command) => {
      const entryId = `compact-entry-${++nextEntryId}`;
      rememberPendingEntry(pendingCommandEntryIds, command, entryId);
      await addEntry({
        id: entryId,
        summary: formatCompactCommand(command),
        failed: false,
      });
    },
    completeCommand: async (command) => {
      consumePendingEntry(pendingCommandEntryIds, command);
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
      const entryId = `compact-entry-${++nextEntryId}`;
      rememberPendingEntry(pendingCommandEntryIds, command, entryId);
      await addEntry({
        id: entryId,
        summary: formatCompactRead(paths),
        failed: false,
      });
    },
    addToolCall: async (toolCall, actionFormatter, toolContext) => {
      const entryId = `compact-entry-${++nextEntryId}`;
      pendingToolEntryIds.push(entryId);
      await addEntry({
        id: entryId,
        summary: formatCompactToolCall(toolCall, actionFormatter, cwd, toolContext),
        failed: false,
      });
    },
    failMostRecentToolCall: async () => {
      while (pendingToolEntryIds.length > 0) {
        const entryId = pendingToolEntryIds.pop();
        if (typeof entryId !== "string" || !markEntryFailed(entryId)) {
          continue;
        }
        await flushNow();
        return true;
      }
      return false;
    },
    close,
  };
}
