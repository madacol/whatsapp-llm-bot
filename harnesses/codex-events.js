/**
 * Normalize Codex JSON events into the harness-level semantic events used by
 * the rest of the bot.
 */

/**
 * @typedef {{
 *   command: string,
 *   status: "started" | "completed" | "failed",
 *   output?: string,
 * }} CodexCommandEvent
 */

/**
 * @typedef {{
 *   path: string,
 *   summary?: string,
 * }} CodexFileChangeEvent
 */

/**
 * @typedef {{
 *   sessionId: string | null,
 *   usage?: HarnessUsage,
 *   failureMessage?: string,
 *   commandEvent?: CodexCommandEvent,
 *   assistantText?: string,
 *   planText?: string,
 *   fileChange?: CodexFileChangeEvent,
 * }} NormalizedCodexEvent
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extract a session id from a Codex event when present.
 * @param {unknown} event
 * @returns {string | null}
 */
export function extractCodexSessionId(event) {
  if (!isRecord(event)) {
    return null;
  }
  if (typeof event.thread_id === "string") {
    return event.thread_id;
  }
  if (typeof event.session_id === "string") {
    return event.session_id;
  }
  if (isRecord(event.thread) && typeof event.thread.id === "string") {
    return event.thread.id;
  }
  if (isRecord(event.item) && typeof event.item.thread_id === "string") {
    return event.item.thread_id;
  }
  if (isRecord(event.item) && isRecord(event.item.thread) && typeof event.item.thread.id === "string") {
    return event.item.thread.id;
  }
  return null;
}

/**
 * Best-effort text extraction from Codex event payloads.
 * @param {unknown} value
 * @returns {string | null}
 */
export function extractCodexText(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = extractCodexText(parsed);
        if (nested) {
          return nested;
        }
      } catch {
        // Fall through to the raw string when the payload is not valid JSON.
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(extractCodexText).filter((part) => typeof part === "string" && part.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of ["text", "message", "output", "stdout", "stderr", "content", "summary", "details", "error"]) {
    const nested = extractCodexText(value[key]);
    if (nested) {
      return nested;
    }
  }

  if (Array.isArray(value.steps)) {
    const stepText = value.steps.map(extractCodexText).filter((part) => typeof part === "string" && part.length > 0);
    if (stepText.length > 0) {
      return stepText.join("\n");
    }
  }

  return null;
}

/**
 * Build a short display string for command events.
 * @param {unknown} item
 * @returns {string | null}
 */
function extractCommandText(item) {
  if (!isRecord(item)) {
    return null;
  }
  for (const key of ["command", "command_line", "cmd", "input"]) {
    if (typeof item[key] === "string" && item[key].length > 0) {
      return item[key];
    }
  }
  return extractCodexText(item.command) ?? null;
}

/**
 * Extract output text for command completion/failure events.
 * @param {unknown} item
 * @returns {string | undefined}
 */
function extractCommandOutput(item) {
  const text = extractCodexText(item);
  return text ?? undefined;
}

/**
 * Extract a file path from a Codex event item when present.
 * @param {unknown} item
 * @returns {string | null}
 */
function extractFilePath(item) {
  if (!isRecord(item)) {
    return null;
  }
  if (Array.isArray(item.changes)) {
    const firstChange = item.changes.find(isRecord);
    if (firstChange && typeof firstChange.path === "string" && firstChange.path.length > 0) {
      return firstChange.path;
    }
  }
  for (const key of ["path", "file_path", "file"]) {
    if (typeof item[key] === "string" && item[key].length > 0) {
      return item[key];
    }
  }
  return null;
}

/**
 * @param {unknown} item
 * @returns {string | undefined}
 */
function extractFileSummary(item) {
  if (!isRecord(item)) {
    return undefined;
  }
  if (Array.isArray(item.changes)) {
    const parts = item.changes
      .filter(isRecord)
      .map((change) => {
        if (typeof change.path === "string" && typeof change.kind === "string") {
          return `${change.path} (${change.kind})`;
        }
        if (typeof change.path === "string") {
          return change.path;
        }
        return null;
      })
      .filter((part) => typeof part === "string" && part.length > 0);
    if (parts.length > 0) {
      return parts.join(", ");
    }
  }
  return extractCodexText(item) ?? undefined;
}

/**
 * @param {unknown} item
 * @returns {string | null}
 */
function extractPlanText(item) {
  if (!isRecord(item)) {
    return null;
  }
  if (Array.isArray(item.items)) {
    const lines = item.items
      .filter(isRecord)
      .map((entry) => typeof entry.text === "string" ? entry.text : null)
      .filter((text) => typeof text === "string" && text.length > 0);
    if (lines.length > 0) {
      return lines.join("\n");
    }
  }
  return extractCodexText(item);
}

/**
 * Normalize a parsed Codex JSON event into the semantic event shape used by the
 * harness wrapper.
 * @param {unknown} event
 * @returns {NormalizedCodexEvent | null}
 */
export function normalizeCodexEvent(event) {
  if (!isRecord(event)) {
    return null;
  }

  /** @type {NormalizedCodexEvent} */
  const normalized = {
    sessionId: extractCodexSessionId(event),
  };

  const eventType = typeof event.type === "string" ? event.type : null;
  const item = isRecord(event.item) ? event.item : null;
  const itemType = item && typeof item.type === "string" ? item.type : null;
  const usage = isRecord(event.usage) ? event.usage : null;

  if (eventType === "turn.completed") {
    normalized.usage = {
      promptTokens: typeof usage?.input_tokens === "number"
        ? usage.input_tokens
        : typeof event.input_tokens === "number" ? event.input_tokens : 0,
      completionTokens: typeof usage?.output_tokens === "number"
        ? usage.output_tokens
        : typeof event.output_tokens === "number" ? event.output_tokens : 0,
      cachedTokens: typeof usage?.cached_input_tokens === "number"
        ? usage.cached_input_tokens
        : typeof event.cached_input_tokens === "number" ? event.cached_input_tokens : 0,
      cost: 0,
    };
    return normalized;
  }

  if (eventType === "turn.failed" || eventType === "error") {
    normalized.failureMessage = extractCodexText(event) ?? "Codex run failed.";
    return normalized;
  }

  if (!item || !itemType) {
    return normalized;
  }

  if (eventType === "item.started" && itemType === "command_execution") {
    const command = extractCommandText(item);
    if (command) {
      normalized.commandEvent = { command, status: "started" };
    }
    return normalized;
  }

  if (eventType === "item.completed" && itemType === "command_execution") {
    const command = extractCommandText(item);
    if (command) {
      normalized.commandEvent = {
        command,
        status: "completed",
        output: extractCommandOutput(item),
      };
    }
    return normalized;
  }

  if (eventType === "item.failed" && itemType === "command_execution") {
    normalized.commandEvent = {
      command: extractCommandText(item) ?? "command",
      status: "failed",
      output: extractCommandOutput(item),
    };
    return normalized;
  }

  if (eventType === "item.completed" && itemType === "agent_message") {
    normalized.assistantText = extractCodexText(item) ?? undefined;
    return normalized;
  }

  if (eventType === "item.completed" && (itemType.includes("plan") || itemType === "todo_list")) {
    normalized.planText = extractPlanText(item) ?? undefined;
    return normalized;
  }

  if (eventType === "item.completed" && (itemType.includes("file") || itemType.includes("patch"))) {
    const filePath = extractFilePath(item);
    if (filePath) {
      normalized.fileChange = {
        path: filePath,
        summary: extractFileSummary(item),
      };
    }
    return normalized;
  }

  return normalized;
}
