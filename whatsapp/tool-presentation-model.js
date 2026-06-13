/**
 * Transport-neutral tool presentation model.
 *
 * This module infers semantic UI intents from raw tool calls and command
 * events without deciding how a specific transport should render them.
 */

import { createPlanPresentationFromState, normalizePlanEntryStatus } from "../plan-presentation.js";

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
 * @typedef {"Read" | "Search" | "List" | "Plan" | "Web" | "Open Link" | "Find On Page" | "Run Command" | "Start Agent" | "Message Agent" | "Wait For Agent" | "Resume Agent" | "Close Agent" | "Run Parallel" | "stdin"} ToolActivityTitle
 */

/**
 * @typedef {{
 *   title: ToolActivityTitle,
 *   lines: string[],
 * }} ToolActivitySummary
 */

/**
 * @typedef {"bash" | "read" | "grep" | "glob" | "plain" | "web_search" | "open_link" | "find_on_page"} ToolInspectMode
 */

/**
 * @typedef {{
 *   groupKey: string,
 *   groupTitle: string,
 *   detail: string,
 * }} ToolFlowDescriptor
 */

/**
 * @typedef {{
 *   kind: "activity",
 *   toolName: string,
 *   summary: string,
 *   activity: ToolActivitySummary,
 *   inspectMode: ToolInspectMode,
 *   flow?: ToolFlowDescriptor,
 * }} ActivityPresentation
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
 * @typedef {ActivityPresentation | import("../plan-presentation.js").PlanPresentation | BashPresentation | FilePresentation | GenericPresentation} ToolPresentation
 */

/**
 * @param {ToolActivitySummary} activity
 * @returns {string}
 */
function formatActivitySummary(activity) {
  if (activity.lines.length === 0) {
    return `*${activity.title}*`;
  }
  if (activity.lines.length === 1) {
    return `*${activity.title}*  ${activity.lines[0]}`;
  }
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
 * @param {string | null | undefined} targetPath
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function formatBoldDisplayPath(targetPath, cwd) {
  return `*${shortenPath(targetPath || ".", cwd)}*`;
}

/**
 * @param {"Edit" | "Write"} name
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string; startLine?: number } | undefined} context
 * @returns {string}
 */
function formatFileToolSummary(name, args, cwd, context) {
  const filePath = typeof args.file_path === "string" ? args.file_path : ".";
  const action = name === "Edit"
    ? "Editing"
    : typeof context?.oldContent === "string"
      ? "Updating"
      : "Writing";
  let summary = `${action} ${formatDisplayPath(filePath, cwd)}`;

  if (context?.startLine != null) {
    const lineCount = typeof args.old_string === "string" ? args.old_string.split("\n").length : 1;
    summary += lineCount > 1
      ? `  _L${context.startLine}–${context.startLine + lineCount - 1}_`
      : `  _L${context.startLine}_`;
  }

  return summary;
}

/**
 * @param {string} refId
 * @returns {string}
 */
function formatWebRef(refId) {
  try {
    const url = new URL(refId);
    const path = url.pathname === "/" && !url.search ? "" : `${url.pathname}${url.search}`;
    return `\`${url.host}${path}\``;
  } catch {
    return `\`${refId}\``;
  }
}

/**
 * @param {ToolActivityTitle} title
 * @param {string | null | undefined} [line]
 * @returns {ToolActivitySummary}
 */
function createActivity(title, line) {
  return { title, lines: typeof line === "string" && line.length > 0 ? [line] : [] };
}

/**
 * @param {string} groupKey
 * @param {string} groupTitle
 * @param {string} detail
 * @returns {ToolFlowDescriptor}
 */
function createFlow(groupKey, groupTitle, detail) {
  return { groupKey, groupTitle, detail };
}

/**
 * @param {Record<string, unknown>} args
 * @returns {{ start: number, end: number } | null}
 */
function getReadLineRange(args) {
  const rawStart = typeof args.line === "number" ? args.line : args.offset;
  if (typeof rawStart !== "number" || !Number.isInteger(rawStart) || rawStart <= 0) {
    return null;
  }
  const limit = args.limit;
  if (typeof limit === "number") {
    if (!Number.isInteger(limit) || limit <= 0) {
      return null;
    }
    return { start: rawStart, end: rawStart + limit - 1 };
  }
  return { start: rawStart, end: rawStart };
}

/**
 * @param {string} path
 * @param {string | null | undefined} cwd
 * @param {{ start: number, end: number } | null} range
 * @returns {ActivityPresentation}
 */
function createReadPresentation(path, cwd, range) {
  const suffix = range ? `:${range.start === range.end ? range.start : `${range.start}-${range.end}`}` : "";
  const line = `\`${shortenPath(path || ".", cwd)}${suffix}\``;
  const activity = createActivity("Read", line);
  return {
    kind: "activity",
    toolName: "Read",
    summary: formatActivitySummary(activity),
    activity,
    inspectMode: "read",
  };
}

/**
 * @param {string} pattern
 * @param {string | undefined} path
 * @param {string | null | undefined} cwd
 * @returns {ActivityPresentation}
 */
function createSearchPresentation(pattern, path, cwd) {
  const suffix = path ? ` in ${formatBoldDisplayPath(path, cwd)}` : "";
  const activity = createActivity("Search", `\`${pattern}\`${suffix}`);
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
 * @param {ToolActivityTitle} title
 * @param {string} toolName
 * @param {string | null | undefined} line
 * @param {ToolInspectMode} inspectMode
 * @param {ToolFlowDescriptor | undefined} [flow]
 * @returns {ActivityPresentation}
 */
function createSimpleActivityPresentation(title, toolName, line, inspectMode, flow) {
  const activity = createActivity(title, line);
  return {
    kind: "activity",
    toolName,
    summary: formatActivitySummary(activity),
    activity,
    inspectMode,
    ...(flow ? { flow } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is { q: string }}
 */
function hasQueryString(value) {
  return isRecord(value) && typeof value.q === "string";
}

/**
 * @param {unknown} value
 * @returns {value is { ref_id: string, lineno?: number }}
 */
function hasOpenRef(value) {
  return isRecord(value)
    && typeof value.ref_id === "string"
    && (value.lineno == null || typeof value.lineno === "number");
}

/**
 * @param {unknown} value
 * @returns {value is { ref_id: string, pattern: string }}
 */
function hasFindArgs(value) {
  return isRecord(value)
    && typeof value.ref_id === "string"
    && typeof value.pattern === "string";
}

/**
 * @template T
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @param {(value: unknown) => value is T} guard
 * @returns {T | null}
 */
function extractToolArgs(args, key, guard) {
  if (guard(args)) {
    return args;
  }
  const nested = args[key];
  if (!Array.isArray(nested) || nested.length === 0) {
    return null;
  }
  return guard(nested[0]) ? nested[0] : null;
}

/**
 * @param {string} query
 * @returns {ActivityPresentation}
 */
function createWebSearchPresentation(query) {
  const detail = quoteForDisplay(query);
  return createSimpleActivityPresentation(
    "Web",
    "Web",
    detail,
    "web_search",
    createFlow("web", "Web", `search ${detail}`),
  );
}

/**
 * @param {string} refId
 * @returns {ActivityPresentation}
 */
function createOpenLinkPresentation(refId) {
  const detail = formatWebRef(refId);
  return createSimpleActivityPresentation(
    "Open Link",
    "Open Link",
    detail,
    "open_link",
    createFlow("web", "Web", `open ${detail}`),
  );
}

/**
 * @param {string} pattern
 * @param {string} refId
 * @returns {ActivityPresentation}
 */
function createFindOnPagePresentation(pattern, refId) {
  const displayPattern = quoteForDisplay(pattern);
  return createSimpleActivityPresentation(
    "Find On Page",
    "Find On Page",
    `${displayPattern} in ${formatWebRef(refId)}`,
    "find_on_page",
    createFlow("web", "Web", `find ${displayPattern}`),
  );
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
 * @returns {import("../plan-presentation.js").PlanEntry[]}
 */
function getUpdatePlanEntries(args) {
  /** @type {import("../plan-presentation.js").PlanEntry[]} */
  const entries = [];

  if (Array.isArray(args.plan)) {
    for (const item of args.plan) {
      if (!isRecord(item) || typeof item.step !== "string" || typeof item.status !== "string") {
        continue;
      }
      entries.push({
        text: item.step,
        status: normalizePlanEntryStatus(item.status),
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
 * @returns {import("../plan-presentation.js").PlanPresentation}
 */
function createPlanPresentation(args) {
  return createPlanPresentationFromState({
    explanation: getUpdatePlanExplanation(args),
    entries: getUpdatePlanEntries(args),
  });
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {ToolPresentation | null}
 */
function buildSdkPresentation(name, args, cwd) {
  switch (name) {
    case "search_query": {
      const queryArgs = extractToolArgs(args, "search_query", hasQueryString);
      return queryArgs ? createWebSearchPresentation(queryArgs.q) : null;
    }
    case "open": {
      const openArgs = extractToolArgs(args, "open", hasOpenRef);
      return openArgs ? createOpenLinkPresentation(openArgs.ref_id) : null;
    }
    case "find": {
      const findArgs = extractToolArgs(args, "find", hasFindArgs);
      return findArgs ? createFindOnPagePresentation(findArgs.pattern, findArgs.ref_id) : null;
    }
    case "Read":
    case "Read file": {
      const readPath = typeof args.file_path === "string"
        ? args.file_path
        : typeof args.path === "string" ? args.path : null;
      return readPath ? createReadPresentation(readPath, cwd, getReadLineRange(args)) : null;
    }
    case "Grep":
    case "Search":
      return typeof args.pattern === "string"
        ? createSearchPresentation(args.pattern, typeof args.path === "string" ? args.path : undefined, cwd)
        : null;
    case "Glob":
      return typeof args.pattern === "string"
        ? createGlobPresentation(args.pattern, typeof args.path === "string" ? args.path : undefined, cwd)
        : null;
    case "WebSearch":
      return typeof args.query === "string" ? createWebSearchPresentation(args.query) : null;
    case "update_plan":
      return createPlanPresentation(args);
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
 * @returns {ToolPresentation | null}
 */
export function buildToolPresentation(name, args, formatToolCall, cwd, context) {
  const sdkPresentation = buildSdkPresentation(name, args, cwd);
  if (sdkPresentation) {
    return sdkPresentation;
  }

  if ((name === "Edit" || name === "Write") && typeof args.file_path === "string") {
    const summary = formatFileToolSummary(name, args, cwd, context);
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
    const prompt = typeof args.prompt === "string"
      ? args.prompt
      : typeof args.message === "string"
        ? args.message
        : null;
    return createSimpleActivityPresentation("Start Agent", "Start Agent", prompt ? `_${prompt}_` : undefined, "plain");
  }

  if (name === "send_input") {
    const message = typeof args.message === "string"
      ? args.message
      : typeof args.prompt === "string"
        ? args.prompt
        : null;
    return createSimpleActivityPresentation("Message Agent", "Message Agent", message ? `_${message}_` : undefined, "plain");
  }

  if (name === "wait_agent") {
    const ids = Array.isArray(args.receiver_thread_ids)
      ? args.receiver_thread_ids
      : Array.isArray(args.ids)
        ? args.ids
        : [];
    const count = ids.length;
    return createSimpleActivityPresentation(
      "Wait For Agent",
      "Wait For Agent",
      count > 0 ? `_${count} agent${count === 1 ? "" : "s"}_` : undefined,
      "plain",
    );
  }

  if (name === "resume_agent") {
    return createSimpleActivityPresentation(
      "Resume Agent",
      "Resume Agent",
      typeof args.id === "string" ? `\`${args.id}\`` : undefined,
      "plain",
    );
  }

  if (name === "close_agent") {
    return createSimpleActivityPresentation(
      "Close Agent",
      "Close Agent",
      typeof args.id === "string" ? `\`${args.id}\`` : undefined,
      "plain",
    );
  }

  if (name === "parallel") {
    const toolUses = Array.isArray(args.tool_uses) ? args.tool_uses.length : 0;
    return createSimpleActivityPresentation(
      "Run Parallel",
      "Run Parallel",
      toolUses > 0 ? `_${toolUses} tool${toolUses === 1 ? "" : "s"}_` : undefined,
      "plain",
    );
  }

  if (name === "write_stdin" || name === "stdin") {
    const stdin = typeof args.stdin === "string" && args.stdin.length > 0
      ? args.stdin
      : typeof args.chars === "string" && args.chars.length > 0
        ? args.chars
        : null;
    if (!stdin) {
      return null;
    }
    return createSimpleActivityPresentation(
      "stdin",
      "stdin",
      quoteForDisplay(stdin),
      "plain",
    );
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
 * @param {ToolPresentation} presentation
 * @returns {ToolFlowDescriptor | null}
 */
export function getToolFlowDescriptor(presentation) {
  return presentation.kind === "activity" && presentation.flow
    ? presentation.flow
    : null;
}
