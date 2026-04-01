import { extractCodexText, isCodexEventRecord } from "./codex-event-utils.js";

/**
 * Build a short display string for command events.
 * @param {unknown} item
 * @returns {string | null}
 */
export function extractCommandText(item) {
  if (!isCodexEventRecord(item)) {
    return null;
  }
  for (const key of ["command", "command_line", "cmd", "input"]) {
    if (typeof item[key] === "string" && item[key].length > 0) {
      return unwrapShellCommand(item[key]);
    }
  }
  const text = extractCodexText(item.command);
  return text ? unwrapShellCommand(text) : null;
}

/**
 * Codex command executions often report the shell wrapper that launched the
 * command. Strip that transport noise so the user sees the command the agent
 * actually intended to run.
 * @param {string} command
 * @returns {string}
 */
function unwrapShellCommand(command) {
  const match = command.match(
    /^(?:(?:\/usr\/bin\/env)\s+)?(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc(?:\s+(['"])([\s\S]*)\1|\s+([\s\S]+))$/,
  );
  if (!match) {
    return command;
  }
  const quote = match[1];
  const inner = match[2] ?? match[3] ?? "";
  if (!quote) {
    return inner;
  }
  if (quote === "\"") {
    return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return inner.replace(/'\\''/g, "'");
}

/**
 * Extract output text for command completion/failure events.
 * @param {unknown} item
 * @returns {string | undefined}
 */
export function extractCommandOutput(item) {
  if (!isCodexEventRecord(item)) {
    return undefined;
  }

  const directOutput = [
    item.aggregated_output,
    item.aggregatedOutput,
    item.output,
    item.stdout,
    item.stderr,
    item.content,
    item.details,
    item.data,
  ];

  for (const candidate of directOutput) {
    const text = extractCodexText(candidate);
    if (text != null) {
      return text;
    }
  }

  return undefined;
}

/**
 * Extract text from a completed MCP tool result when possible.
 * @param {unknown} result
 * @returns {string | undefined}
 */
export function extractToolResultOutput(result) {
  if (!isCodexEventRecord(result)) {
    return undefined;
  }

  if (Array.isArray(result.content)) {
    const textParts = result.content
      .map((block) => extractCodexText(block))
      .filter((text) => typeof text === "string" && text.length > 0);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  const structured = extractCodexText(result.structured_content);
  if (structured) {
    return structured;
  }

  const serializedStructured = serializeStructuredToolResult(result.structured_content);
  if (serializedStructured) {
    return serializedStructured;
  }

  return extractCodexText(result) ?? serializeStructuredToolResult(result);
}

/**
 * Fall back to JSON for structured tool results that do not expose a text-ish
 * field. This keeps inspect useful for tools like the web MCP, which often
 * returns records/arrays of results instead of text blocks.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function serializeStructuredToolResult(value) {
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value) || isCodexEventRecord(value)) {
    return JSON.stringify(value, null, 2);
  }
  return undefined;
}

/**
 * Extract text from collab tool state when possible.
 * @param {unknown} states
 * @returns {string | undefined}
 */
export function extractCollabToolOutput(states) {
  if (!isCodexEventRecord(states)) {
    return undefined;
  }

  const messages = Object.values(states)
    .filter(isCodexEventRecord)
    .map((state) => typeof state.message === "string" ? state.message : null)
    .filter((message) => typeof message === "string" && message.length > 0);

  return messages.length > 0 ? messages.join("\n") : undefined;
}

/**
 * @param {string} toolName
 * @returns {string}
 */
export function normalizeCollabToolName(toolName) {
  switch (toolName) {
    case "wait":
      return "wait_agent";
    default:
      return toolName;
  }
}

/**
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
export function extractCollabToolArguments(item) {
  /** @type {Record<string, unknown>} */
  const args = {};

  if (typeof item.prompt === "string" && item.prompt.length > 0) {
    args.prompt = item.prompt;
  }
  if (Array.isArray(item.receiver_thread_ids) && item.receiver_thread_ids.length > 0) {
    args.receiver_thread_ids = item.receiver_thread_ids;
  }
  if (Array.isArray(item.agents_states) && item.agents_states.length > 0) {
    args.agents_states = item.agents_states;
  }

  return args;
}

/**
 * Extract a textual plan representation from a Codex event item when present.
 * @param {unknown} item
 * @returns {string | null}
 */
export function extractPlanText(item) {
  if (!isCodexEventRecord(item)) {
    return null;
  }
  if (Array.isArray(item.items)) {
    const lines = item.items
      .filter(isCodexEventRecord)
      .map((entry) => typeof entry.text === "string" ? entry.text : null)
      .filter((text) => typeof text === "string" && text.length > 0);
    if (lines.length > 0) {
      return lines.join("\n");
    }
  }
  return extractCodexText(item);
}

/**
 * @param {unknown} status
 * @returns {"completed" | "in_progress" | "pending" | "unknown"}
 */
export function normalizePlanStatus(status) {
  if (status === "completed") {
    return "completed";
  }
  if (status === "in_progress" || status === "inProgress") {
    return "in_progress";
  }
  if (status === "pending") {
    return "pending";
  }
  return "unknown";
}

/**
 * @param {unknown} value
 * @returns {import("./codex-events.js").CodexPlanEntry[]}
 */
export function extractPlanEntries(value) {
  /** @type {import("./codex-events.js").CodexPlanEntry[]} */
  const entries = [];
  if (!Array.isArray(value)) {
    return entries;
  }

  for (const entry of value) {
    if (!isCodexEventRecord(entry)) {
      continue;
    }
    if (typeof entry.step === "string" && entry.step.trim().length > 0) {
      entries.push({
        text: entry.step.trim(),
        status: normalizePlanStatus(entry.status),
      });
      continue;
    }
    if (typeof entry.text === "string" && entry.text.trim().length > 0 && typeof entry.completed === "boolean") {
      entries.push({
        text: entry.text.trim(),
        status: entry.completed ? "completed" : "pending",
      });
    }
  }

  return entries;
}

/**
 * @param {unknown} item
 * @returns {import("./codex-events.js").CodexPlanState | null}
 */
export function extractPlanState(item) {
  if (!isCodexEventRecord(item)) {
    return null;
  }

  const explanation = typeof item.explanation === "string" && item.explanation.trim().length > 0
    ? item.explanation.trim()
    : null;
  const entries = extractPlanEntries(item.plan);
  if (entries.length > 0) {
    return { explanation, entries };
  }

  const itemEntries = extractPlanEntries(item.items);
  if (itemEntries.length > 0) {
    return { explanation, entries: itemEntries };
  }

  const text = extractCodexText(item);
  if (!text) {
    return null;
  }
  const textEntries = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ text: line, status: /** @type {"pending"} */ ("pending") }));
  if (textEntries.length === 0) {
    return null;
  }

  return {
    explanation,
    entries: textEntries,
  };
}
