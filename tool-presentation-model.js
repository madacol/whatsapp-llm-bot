/**
 * Transport-neutral tool presentation model.
 *
 * This module infers semantic UI intents from raw tool calls and command
 * events without deciding how a specific transport should render them.
 */

/**
 * Shorten an absolute path by replacing the cwd prefix with ".".
 * @param {string} p
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
export function shortenPath(p, cwd) {
  if (!cwd) return p;
  if (p === cwd) return ".";
  return p.replace(cwd + "/", "");
}

/**
 * @typedef {"Read" | "Search" | "List" | "Plan"} ToolActivityTitle
 */

/**
 * @typedef {{
 *   title: ToolActivityTitle,
 *   lines: string[],
 * }} ToolActivitySummary
 */

/**
 * @typedef {{
 *   text: string,
 *   status: "completed" | "in_progress" | "pending" | "unknown",
 * }} PlanEntry
 */

/**
 * @typedef {"bash" | "read" | "grep" | "glob" | "plain"} ToolInspectMode
 */

/**
 * @typedef {{
 *   kind: "activity",
 *   toolName: string,
 *   summary: string,
 *   activity: ToolActivitySummary,
 *   inspectMode: ToolInspectMode,
 * }} ActivityPresentation
 */

/**
 * @typedef {{
 *   kind: "plan",
 *   toolName: string,
 *   summary: string,
 *   explanation: string | null,
 *   entries: PlanEntry[],
 * }} PlanPresentation
 */

/**
 * @typedef {{
 *   kind: "bash",
 *   toolName: string,
 *   summary: string,
 *   command: string,
 *   inspectMode: ToolInspectMode,
 * }} BashPresentation
 */

/**
 * @typedef {{
 *   kind: "file",
 *   toolName: "Edit" | "Write",
 *   summary: string,
 *   filePath: string,
 *   oldString?: string,
 *   newString?: string,
 *   content?: string,
 *   oldContent?: string,
 *   startLine?: number,
 * }} FilePresentation
 */

/**
 * @typedef {{
 *   kind: "generic",
 *   toolName: string,
 *   summary: string,
 *   description?: string,
 *   args: Record<string, unknown>,
 * }} GenericPresentation
 */

/**
 * @typedef {ActivityPresentation | PlanPresentation | BashPresentation | FilePresentation | GenericPresentation} ToolPresentation
 */

/**
 * @param {ToolActivitySummary} activity
 * @returns {string}
 */
export function formatActivitySummary(activity) {
  return [`*${activity.title}*`, ...activity.lines].join("\n");
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteForDisplay(value) {
  return JSON.stringify(value);
}

/**
 * @param {string | null | undefined} targetPath
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function formatDisplayPath(targetPath, cwd) {
  return `\`${shortenPath(targetPath || ".", cwd)}\``;
}

/**
 * @param {string} command
 * @returns {string}
 */
function extractPrimaryShellSegment(command) {
  const firstLine = command
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  const match = firstLine.match(/^(.*?)(?:\s*(?:\|\||&&|\||;)\s+|$)/);
  return (match?.[1] ?? firstLine).trim();
}

/**
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeShellWords(command) {
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  /** @type {'"' | "'" | null} */
  let quote = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * @param {string[]} tokens
 * @returns {{ mode: "list" | "search", pattern?: string, path?: string } | null}
 */
function classifyRipgrep(tokens) {
  let filesMode = false;
  /** @type {string | undefined} */
  let pattern;
  /** @type {string | undefined} */
  let path;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "--files") {
      filesMode = true;
      continue;
    }
    if (token === "-e" || token === "--regexp") {
      pattern = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token === "-g" || token === "--glob" || token === "-f" || token === "--file") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (filesMode) {
      path = token;
      break;
    }
    if (!pattern) {
      pattern = token;
      continue;
    }
    path = token;
    break;
  }

  if (filesMode) {
    return { mode: "list", path };
  }
  return pattern ? { mode: "search", pattern, path } : null;
}

/**
 * @param {string[]} tokens
 * @returns {{ pattern: string, path?: string } | null}
 */
function classifyGrep(tokens) {
  /** @type {string | undefined} */
  let pattern;
  /** @type {string | undefined} */
  let path;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "-e" || token === "--regexp") {
      pattern = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token === "--include" || token === "--exclude" || token === "--exclude-dir") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (!pattern) {
      pattern = token;
      continue;
    }
    path = token;
    break;
  }

  return pattern ? { pattern, path } : null;
}

/**
 * @param {ToolActivityTitle} title
 * @param {string} line
 * @returns {ToolActivitySummary}
 */
function createActivity(title, line) {
  return { title, lines: [line] };
}

/**
 * @param {string} path
 * @param {string | null | undefined} cwd
 * @returns {ActivityPresentation}
 */
function createReadPresentation(path, cwd) {
  const activity = createActivity("Read", formatDisplayPath(path, cwd));
  return {
    kind: "activity",
    toolName: "Read",
    summary: formatActivitySummary(activity),
    activity,
    inspectMode: "read",
  };
}

/**
 * @param {string | undefined} path
 * @param {string | null | undefined} cwd
 * @returns {ActivityPresentation}
 */
function createListPresentation(path, cwd) {
  const activity = createActivity("List", formatDisplayPath(path, cwd));
  return {
    kind: "activity",
    toolName: "List",
    summary: formatActivitySummary(activity),
    activity,
    inspectMode: "glob",
  };
}

/**
 * @param {string} pattern
 * @param {string | undefined} path
 * @param {string | null | undefined} cwd
 * @returns {ActivityPresentation}
 */
function createSearchPresentation(pattern, path, cwd) {
  const suffix = path ? ` in ${formatDisplayPath(path, cwd)}` : "";
  const activity = createActivity("Search", `${quoteForDisplay(pattern)}${suffix}`);
  return {
    kind: "activity",
    toolName: "Search",
    summary: formatActivitySummary(activity),
    activity,
    inspectMode: "grep",
  };
}

/**
 * @param {string} pattern
 * @param {string | undefined} path
 * @param {string | null | undefined} cwd
 * @returns {ActivityPresentation}
 */
function createGlobPresentation(pattern, path, cwd) {
  const suffix = path ? ` in ${formatDisplayPath(path, cwd)}` : "";
  const activity = createActivity("List", `\`${pattern}\`${suffix}`);
  return {
    kind: "activity",
    toolName: "List",
    summary: formatActivitySummary(activity),
    activity,
    inspectMode: "glob",
  };
}

/**
 * @param {string[]} tokens
 * @returns {string | undefined}
 */
function findLastNonOptionToken(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && !token.startsWith("-")) {
      return token;
    }
  }
  return undefined;
}

/**
 * @param {string} command
 * @param {string | null | undefined} cwd
 * @returns {ActivityPresentation | null}
 */
export function classifyCommandActivity(command, cwd) {
  const primaryCommand = extractPrimaryShellSegment(command);
  const tokens = tokenizeShellWords(primaryCommand);
  const name = tokens[0];

  if (!name) {
    return null;
  }

  switch (name) {
    case "rg": {
      const match = classifyRipgrep(tokens);
      if (!match) {
        return null;
      }
      return match.mode === "list"
        ? createListPresentation(match.path, cwd)
        : createSearchPresentation(match.pattern ?? "", match.path, cwd);
    }
    case "grep": {
      const match = classifyGrep(tokens);
      return match ? createSearchPresentation(match.pattern, match.path, cwd) : null;
    }
    case "ls": {
      const targetPath = tokens.slice(1).find((token) => !token.startsWith("-"));
      return createListPresentation(targetPath, cwd);
    }
    case "find":
    case "fd": {
      const targetPath = tokens.slice(1).find((token) => !token.startsWith("-"));
      return createListPresentation(targetPath, cwd);
    }
    case "cat":
    case "bat": {
      const filePath = tokens.slice(1).find((token) => !token.startsWith("-"));
      return filePath ? createReadPresentation(filePath, cwd) : null;
    }
    case "head":
    case "tail":
    case "nl": {
      const filePath = findLastNonOptionToken(tokens.slice(1));
      return filePath ? createReadPresentation(filePath, cwd) : null;
    }
    case "sed": {
      const filePath = findLastNonOptionToken(tokens.slice(1));
      return filePath ? createReadPresentation(filePath, cwd) : null;
    }
    default:
      return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} args
 * @returns {string | null}
 */
function getUpdatePlanExplanation(args) {
  return typeof args.explanation === "string" && args.explanation.trim()
    ? args.explanation.trim()
    : null;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {PlanEntry[]}
 */
function getUpdatePlanEntries(args) {
  /** @type {PlanEntry[]} */
  const entries = [];

  if (Array.isArray(args.plan)) {
    for (const item of args.plan) {
      if (!isRecord(item) || typeof item.step !== "string" || typeof item.status !== "string") {
        continue;
      }
      entries.push({
        text: item.step,
        status: item.status === "completed" || item.status === "in_progress" || item.status === "pending"
          ? item.status
          : "unknown",
      });
    }
    return entries;
  }

  if (Array.isArray(args.items)) {
    for (const item of args.items) {
      if (!isRecord(item) || typeof item.text !== "string" || typeof item.completed !== "boolean") {
        continue;
      }
      entries.push({
        text: item.text,
        status: item.completed ? "completed" : "pending",
      });
    }
  }

  return entries;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {PlanPresentation}
 */
function createPlanPresentation(args) {
  const explanation = getUpdatePlanExplanation(args);
  const entries = getUpdatePlanEntries(args);
  const summary = entries.length > 0
    ? `*Plan*  _${entries.length} step${entries.length === 1 ? "" : "s"}_`
    : explanation
      ? `*Plan*  _${explanation.length > 48 ? `${explanation.slice(0, 48)}…` : explanation}_`
      : "*Plan*";
  return {
    kind: "plan",
    toolName: "update_plan",
    summary,
    explanation,
    entries,
  };
}

/**
 * @param {string} command
 * @returns {string}
 */
function formatBashSummary(command) {
  const lines = command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? "";
  if (!firstLine) {
    return "*Bash*";
  }
  const preview = firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
  const extraLines = Math.max(0, lines.length - 1);
  return extraLines > 0
    ? `*Bash*  \`${preview}\`  _+${extraLines} line${extraLines === 1 ? "" : "s"}_`
    : `*Bash*  \`${preview}\``;
}

/**
 * @param {string} command
 * @param {string | null | undefined} cwd
 * @returns {ToolInspectMode}
 */
function inferBashInspectMode(command, cwd) {
  const activity = classifyCommandActivity(command, cwd);
  if (!activity) {
    return "bash";
  }
  return activity.inspectMode;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {ToolPresentation | null}
 */
function buildSdkPresentation(name, args, cwd) {
  switch (name) {
    case "Read":
      return typeof args.file_path === "string" ? createReadPresentation(args.file_path, cwd) : null;
    case "Grep":
      return typeof args.pattern === "string"
        ? createSearchPresentation(args.pattern, typeof args.path === "string" ? args.path : undefined, cwd)
        : null;
    case "Glob":
      return typeof args.pattern === "string"
        ? createGlobPresentation(args.pattern, typeof args.path === "string" ? args.path : undefined, cwd)
        : null;
    case "WebSearch":
      return typeof args.query === "string" ? createSearchPresentation(args.query, undefined, cwd) : null;
    case "update_plan":
      return createPlanPresentation(args);
    case "Bash":
      return typeof args.command === "string"
        ? {
          kind: "bash",
          toolName: "Bash",
          summary: classifyCommandActivity(args.command, cwd)?.summary ?? formatBashSummary(args.command),
          command: args.command,
          inspectMode: inferBashInspectMode(args.command, cwd),
        }
        : null;
    default:
      return null;
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {((params: Record<string, unknown>) => string) | undefined} formatToolCall
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string; startLine?: number } | undefined} context
 * @returns {ToolPresentation}
 */
export function buildToolPresentation(name, args, formatToolCall, cwd, context) {
  const sdkPresentation = buildSdkPresentation(name, args, cwd);
  if (sdkPresentation) {
    return sdkPresentation;
  }

  if ((name === "Edit" || name === "Write") && typeof args.file_path === "string") {
    let summary = `*${name}*  \`${shortenPath(args.file_path, cwd)}\``;
    if (context?.startLine != null) {
      const lineCount = typeof args.old_string === "string" ? args.old_string.split("\n").length : 1;
      summary += lineCount > 1
        ? `  _L${context.startLine}–${context.startLine + lineCount - 1}_`
        : `  _L${context.startLine}_`;
    }
    return {
      kind: "file",
      toolName: /** @type {"Edit" | "Write"} */ (name),
      summary,
      filePath: args.file_path,
      ...(typeof args.old_string === "string" ? { oldString: args.old_string } : {}),
      ...(typeof args.new_string === "string" ? { newString: args.new_string } : {}),
      ...(typeof args.content === "string" ? { content: args.content } : {}),
      ...(typeof context?.oldContent === "string" ? { oldContent: context.oldContent } : {}),
      ...(typeof context?.startLine === "number" ? { startLine: context.startLine } : {}),
    };
  }

  if (typeof args.description === "string") {
    return {
      kind: "generic",
      toolName: name,
      summary: name === "Agent" ? `*Agent*  _${args.description}_` : args.description,
      description: args.description,
      args,
    };
  }

  if (name === "spawn_agent") {
    return {
      kind: "generic",
      toolName: name,
      summary: typeof args.prompt === "string" ? `*spawn_agent*  _${args.prompt}_` : "*spawn_agent*",
      args,
    };
  }

  if (name === "send_input") {
    const message = typeof args.message === "string"
      ? args.message
      : typeof args.prompt === "string"
        ? args.prompt
        : null;
    return {
      kind: "generic",
      toolName: name,
      summary: message ? `*send_input*  _${message}_` : "*send_input*",
      args,
    };
  }

  if (name === "wait_agent") {
    const count = Array.isArray(args.receiver_thread_ids) ? args.receiver_thread_ids.length : 0;
    return {
      kind: "generic",
      toolName: name,
      summary: count > 0
        ? `*wait_agent*  _${count} agent${count === 1 ? "" : "s"}_`
        : "*wait_agent*",
      args,
    };
  }

  if (name === "close_agent" || name === "resume_agent" || name === "parallel") {
    return {
      kind: "generic",
      toolName: name,
      summary: `*${name}*`,
      args,
    };
  }

  if (formatToolCall) {
    return {
      kind: "generic",
      toolName: name,
      summary: formatToolCall(args),
      args,
    };
  }

  if (Object.keys(args).length > 0) {
    const inline = Object.entries(args).map(([key, value]) => {
      const display = typeof value === "string" ? value : JSON.stringify(value);
      return Object.keys(args).length === 1 ? display : `${key}: ${display}`;
    }).join(", ");
    return {
      kind: "generic",
      toolName: name,
      summary: `*${name}*\n${inline}`,
      args,
    };
  }

  return {
    kind: "generic",
    toolName: name,
    summary: `*${name}*`,
    args,
  };
}

/**
 * @param {string} command
 * @param {string | null | undefined} cwd
 * @returns {BashPresentation}
 */
export function buildCommandPresentation(command, cwd) {
  return /** @type {BashPresentation} */ (buildToolPresentation("Bash", { command }, undefined, cwd, undefined));
}

/**
 * @param {string} filePath
 * @param {string | null | undefined} cwd
 * @returns {ActivityPresentation}
 */
export function buildReadToolPresentation(filePath, cwd) {
  return createReadPresentation(filePath, cwd);
}

/**
 * @param {string[]} paths
 * @param {string | null | undefined} cwd
 * @returns {ToolActivitySummary}
 */
export function buildMultiReadActivity(paths, cwd) {
  return {
    title: "Read",
    lines: paths.map((filePath) => `\`${shortenPath(filePath, cwd)}\``),
  };
}
