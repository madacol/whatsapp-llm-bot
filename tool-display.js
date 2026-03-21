/**
 * Pure functions for formatting tool calls and results for WhatsApp display.
 *
 * All functions return `SendContent | null` — the caller decides how to send.
 * `null` means "nothing to display".
 */

import { parseToolArgs } from "./harnesses/index.js";
import { maxCharsForLineCount } from "./code-image-renderer.js";

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

/** Map file extensions to language identifiers for syntax highlighting. */
const EXT_TO_LANG = /** @type {Record<string, string>} */ ({
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", lua: "lua", r: "r", jl: "julia", scala: "scala",
  dart: "dart", zig: "zig", nim: "nim", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", ml: "ocaml", fs: "fsharp",
  clj: "clojure", groovy: "groovy", pl: "perl", pm: "perl",
  sh: "bash", bash: "bash", zsh: "zsh", fish: "fish",
  ps1: "powershell", bat: "bat", cmd: "cmd",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
  less: "less", xml: "xml", svg: "svg", vue: "vue", svelte: "svelte",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  sql: "sql", graphql: "graphql", proto: "protobuf",
  dockerfile: "dockerfile", makefile: "makefile",
  tf: "terraform", hcl: "hcl", tex: "latex",
  md: "markdown", mdx: "mdx",
});

/**
 * Infer a syntax-highlighting language from a file path's extension.
 * @param {string} filePath
 * @returns {string}
 */
export function langFromPath(filePath) {
  const base = filePath.split("/").pop() || "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() ?? "" : "";
  return EXT_TO_LANG[ext] || "";
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
 * Tokenize a shell command segment into whitespace-separated words while
 * preserving quoted sections.
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
function createActivitySummary(title, line) {
  return { title, lines: [line] };
}

/**
 * @param {string} path
 * @param {string | null | undefined} cwd
 * @returns {ToolActivitySummary}
 */
function createReadActivity(path, cwd) {
  return createActivitySummary("Read", formatDisplayPath(path, cwd));
}

/**
 * @param {string | undefined} path
 * @param {string | null | undefined} cwd
 * @returns {ToolActivitySummary}
 */
function createListActivity(path, cwd) {
  return createActivitySummary("List", formatDisplayPath(path, cwd));
}

/**
 * @param {string} pattern
 * @param {string | undefined} path
 * @param {string | null | undefined} cwd
 * @returns {ToolActivitySummary}
 */
function createSearchActivity(pattern, path, cwd) {
  const suffix = path ? ` in ${formatDisplayPath(path, cwd)}` : "";
  return createActivitySummary("Search", `${quoteForDisplay(pattern)}${suffix}`);
}

/**
 * @param {string} pattern
 * @param {string | undefined} path
 * @param {string | null | undefined} cwd
 * @returns {ToolActivitySummary}
 */
function createGlobActivity(pattern, path, cwd) {
  const suffix = path ? ` in ${formatDisplayPath(path, cwd)}` : "";
  return createActivitySummary("List", `\`${pattern}\`${suffix}`);
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
 * @returns {ToolActivitySummary | null}
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
        ? createListActivity(match.path, cwd)
        : createSearchActivity(match.pattern ?? "", match.path, cwd);
    }
    case "grep": {
      const match = classifyGrep(tokens);
      return match ? createSearchActivity(match.pattern, match.path, cwd) : null;
    }
    case "ls": {
      const targetPath = tokens.slice(1).find((token) => !token.startsWith("-"));
      return createListActivity(targetPath, cwd);
    }
    case "find":
    case "fd": {
      const targetPath = tokens.slice(1).find((token) => !token.startsWith("-"));
      return createListActivity(targetPath, cwd);
    }
    case "cat":
    case "bat": {
      const filePath = tokens.slice(1).find((token) => !token.startsWith("-"));
      return filePath ? createReadActivity(filePath, cwd) : null;
    }
    case "head":
    case "tail":
    case "nl": {
      const filePath = findLastNonOptionToken(tokens.slice(1));
      return filePath ? createReadActivity(filePath, cwd) : null;
    }
    case "sed": {
      const filePath = findLastNonOptionToken(tokens.slice(1));
      return filePath ? createReadActivity(filePath, cwd) : null;
    }
    default:
      return null;
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null | undefined} cwd
 * @returns {ToolActivitySummary | null}
 */
export function classifyToolActivity(name, args, cwd) {
  switch (name) {
    case "Read":
      return typeof args.file_path === "string" ? createReadActivity(args.file_path, cwd) : null;
    case "Grep":
      return typeof args.pattern === "string"
        ? createSearchActivity(
          args.pattern,
          typeof args.path === "string" ? args.path : undefined,
          cwd,
        )
        : null;
    case "Glob":
      if (typeof args.pattern !== "string") {
        return null;
      }
      return createGlobActivity(
        args.pattern,
        typeof args.path === "string" ? args.path : undefined,
        cwd,
      );
    case "WebSearch":
      return typeof args.query === "string" ? createSearchActivity(args.query, undefined, cwd) : null;
    case "Bash":
      return typeof args.command === "string" ? classifyCommandActivity(args.command, cwd) : null;
    default:
      return null;
  }
}

/**
 * Format SDK built-in tool calls (Read, Grep, Glob, WebSearch, WebFetch, Agent)
 * into compact, human-friendly strings. Returns null for unknown tools.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | null} [cwd]
 * @returns {string | null}
 */
export function formatSdkToolCall(name, args, cwd) {
  const activity = classifyToolActivity(name, args, cwd);
  if (activity) {
    return formatActivitySummary(activity);
  }

  switch (name) {
    case "Read": {
      const path = typeof args.file_path === "string" ? args.file_path : null;
      if (!path) return null;
      let label = `*Read*  \`${shortenPath(path, cwd)}\``;
      if (typeof args.offset === "number" || typeof args.limit === "number") {
        const parts = [];
        if (typeof args.offset === "number") parts.push(`from L${args.offset}`);
        if (typeof args.limit === "number") parts.push(`${args.limit} lines`);
        label += `  _${parts.join(", ")}_`;
      }
      return label;
    }
    case "Grep": {
      const pattern = typeof args.pattern === "string" ? args.pattern : null;
      if (!pattern) return null;
      let label = `*Grep*  _${pattern}_`;
      if (typeof args.path === "string") label += `\n\`${shortenPath(args.path, cwd)}\``;
      if (typeof args.glob === "string") label += `  (${args.glob})`;
      return label;
    }
    case "Glob": {
      const pattern = typeof args.pattern === "string" ? args.pattern : null;
      if (!pattern) return null;
      let label = `*Glob*  \`${pattern}\``;
      if (typeof args.path === "string") label += `  in \`${shortenPath(args.path, cwd)}\``;
      return label;
    }
    case "WebSearch": {
      const q = typeof args.query === "string" ? args.query : null;
      return q ? `*Search*  _${q}_` : null;
    }
    case "WebFetch": {
      const url = typeof args.url === "string" ? args.url : null;
      return url ? `*Fetch*  ${url}` : null;
    }
    case "Agent": {
      const desc = typeof args.description === "string" ? args.description : null;
      return desc ? `*Agent*  _${desc}_` : null;
    }
    case "spawn_agent": {
      const prompt = typeof args.prompt === "string" ? args.prompt : null;
      return prompt ? `*spawn_agent*  _${prompt}_` : "*spawn_agent*";
    }
    case "send_input": {
      const message = typeof args.message === "string"
        ? args.message
        : typeof args.prompt === "string"
          ? args.prompt
          : null;
      return message ? `*send_input*  _${message}_` : "*send_input*";
    }
    case "wait_agent": {
      return Array.isArray(args.receiver_thread_ids) && args.receiver_thread_ids.length > 0
        ? `*wait_agent*  _${args.receiver_thread_ids.length} agent${args.receiver_thread_ids.length === 1 ? "" : "s"}_`
        : "*wait_agent*";
    }
    case "close_agent":
    case "resume_agent":
    case "parallel":
      return `*${name}*`;
    case "update_plan":
      return formatUpdatePlanSummary(args);
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
 * @param {string} text
 * @param {string} status
 * @returns {string}
 */
function formatPlanLine(text, status) {
  switch (status) {
    case "completed":
      return `[x] ${text}`;
    case "in_progress":
      return `[~] ${text}`;
    case "pending":
      return `[ ] ${text}`;
    default:
      return `[-] ${text}`;
  }
}

/**
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
function getUpdatePlanLines(args) {
  /** @type {string[]} */
  const lines = [];

  if (typeof args.explanation === "string" && args.explanation.trim()) {
    lines.push(`_${args.explanation.trim()}_`);
  }

  if (Array.isArray(args.plan)) {
    for (const item of args.plan) {
      if (!isRecord(item) || typeof item.step !== "string" || typeof item.status !== "string") {
        continue;
      }
      lines.push(formatPlanLine(item.step, item.status));
    }
    return lines;
  }

  if (Array.isArray(args.items)) {
    for (const item of args.items) {
      if (!isRecord(item) || typeof item.text !== "string" || typeof item.completed !== "boolean") {
        continue;
      }
      lines.push(formatPlanLine(item.text, item.completed ? "completed" : "pending"));
    }
  }

  return lines;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {string}
 */
function formatUpdatePlanSummary(args) {
  const lines = getUpdatePlanLines(args);
  return lines.length > 0 ? formatActivitySummary({ title: "Plan", lines }) : "*Plan*";
}

/**
 * Minimum number of characters the longest line must shrink by for a wrap
 * to be worthwhile. Prevents wraps where the continuation line (with its
 * indent) is nearly as wide as the original.
 */
const MIN_WRAP_GAIN = 4;

/**
 * Wrap a single line at the last space that keeps it under `maxWidth`.
 * Continuation lines are indented with `indent` and the previous line
 * gets a trailing ` \` (bash line continuation) for proper syntax highlighting.
 * A wrap is only performed if it shrinks the longest resulting line by at
 * least {@link MIN_WRAP_GAIN} characters; otherwise the line is left as-is.
 * @param {string} line
 * @param {string} indent
 * @param {number} maxWidth
 * @returns {string}
 */
function wrapLongLine(line, indent, maxWidth) {
  if (line.length <= maxWidth) return line;

  /** @type {string[]} */
  const wrapped = [];
  let remaining = line;

  // Reserve 2 chars for the trailing " \" on wrapped lines
  const wrapWidth = maxWidth - 2;

  while (remaining.length > maxWidth) {
    const contentStart = remaining.length - remaining.trimStart().length;
    const breakIdx = remaining.lastIndexOf(" ", wrapWidth);

    if (breakIdx > contentStart) {
      // Check if the continuation line would be meaningfully shorter
      const continuationLen = indent.length + remaining.length - breakIdx - 1;
      if (remaining.length - continuationLen < MIN_WRAP_GAIN) {
        break; // not worth wrapping — leave the rest as-is
      }
      // Space break in actual content — wrap with " \" continuation
      wrapped.push(remaining.slice(0, breakIdx) + " \\");
      remaining = indent + remaining.slice(breakIdx + 1);
    } else {
      // No space in content within width — hard-break with "\"
      const hardContinuationLen = indent.length + remaining.length - wrapWidth;
      if (remaining.length - hardContinuationLen < MIN_WRAP_GAIN) {
        break; // not worth hard-breaking either
      }
      wrapped.push(remaining.slice(0, wrapWidth) + "\\");
      remaining = indent + remaining.slice(wrapWidth);
    }
  }
  wrapped.push(remaining);
  return wrapped.join("\n");
}

/**
 * Apply connector splitting and line wrapping at the given width.
 * @param {string} firstLine
 * @param {string} rest
 * @param {number} maxWidth
 * @returns {string}
 */
function formatWithWidth(firstLine, rest, maxWidth) {
  const parts = firstLine.split(/\s*(\|{1,2}|&&|;)\s+/);

  if (parts.length <= 1) {
    return wrapLongLine(firstLine, "    ", maxWidth) + rest;
  }

  let result = wrapLongLine(parts[0], "    ", maxWidth);
  for (let i = 1; i < parts.length; i += 2) {
    const connector = parts[i];
    const segment = parts[i + 1] ?? "";
    const line = `  ${connector} ${segment}`;
    result += "\n" + wrapLongLine(line, "      ", maxWidth);
  }
  return result + rest;
}

/**
 * Reformat a bash command for visual display:
 * 1. Break at pipes and connectors so each stage starts on its own line
 *    (with 2-space indent for continuation).
 * 2. Wrap lines to keep the rendered code image within WhatsApp's acceptable
 *    aspect ratio. The max character width is derived from the line count
 *    using the code image renderer's pixel dimensions.
 *
 * For multi-line commands (e.g. heredocs), only the first line is split at
 * connectors; the rest is preserved as-is.
 * @param {string} command
 * @returns {string}
 */
export function formatBashCommand(command) {
  const newlineIdx = command.indexOf("\n");
  const firstLine = newlineIdx === -1 ? command : command.slice(0, newlineIdx);
  const rest = newlineIdx === -1 ? "" : command.slice(newlineIdx);

  // First pass: split at connectors only (no char wrapping) to get base line count.
  const connectorParts = firstLine.split(/\s*(\|{1,2}|&&|;)\s+/);
  const baseLineCount = Math.ceil(connectorParts.length / 2);

  // Derive max char width from the aspect ratio constraint, capped at 80.
  // More lines → wider allowed; fewer lines → narrower to avoid thin images.
  const maxWidth = Math.min(80, maxCharsForLineCount(baseLineCount));

  return formatWithWidth(firstLine, rest, maxWidth);
}

/**
 * Return a compact, text-only summary of a tool call suitable for editor
 * updates and message labels. Shared by both harnesses so the display
 * label for a given tool is computed in one place.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {((params: Record<string, any>) => string)} [formatToolCall]
 * @param {string | null} [cwd]
 * @param {{ startLine?: number }} [context]
 * @returns {string}
 */
export function getToolCallSummary(name, args, formatToolCall, cwd, context) {
  const activity = classifyToolActivity(name, args, cwd);
  if (activity) {
    return formatActivitySummary(activity);
  }

  // Bash: always show *Bash* prefix with description or command preview
  if (name === "Bash" && typeof args.command === "string") {
    if (typeof args.description === "string") return `*Bash*  _${args.description}_`;
    const cmd = args.command;
    return cmd.length > 60 ? `*Bash*  \`${cmd.slice(0, 60)}…\`` : `*Bash*  \`${cmd}\``;
  }

  // SDK built-in tools (Read, Grep, Glob, WebSearch, WebFetch, Agent)
  // Checked before generic description so tools like Agent get their *Name* prefix.
  const sdkLabel = formatSdkToolCall(name, args, cwd);
  if (sdkLabel) return sdkLabel;

  // Explicit description (any tool — SDK, native, etc.)
  if (typeof args.description === "string") return args.description;

  // File-path tools
  if ((name === "Edit" || name === "Write" || name === "NotebookEdit") && typeof args.file_path === "string") {
    let label = `*${name}*  \`${shortenPath(args.file_path, cwd)}\``;
    if (context?.startLine != null) {
      const lineCount = typeof args.old_string === "string" ? args.old_string.split("\n").length : 1;
      label += lineCount > 1
        ? `  _L${context.startLine}–${context.startLine + lineCount - 1}_`
        : `  _L${context.startLine}_`;
    }
    return label;
  }

  // Custom actions with formatToolCall
  if (formatToolCall) return formatToolCall(args);

  return name;
}

/**
 * Format a tool call for WhatsApp display. Returns the content to send,
 * or null if nothing should be displayed.
 * @param {LlmChatResponse['toolCalls'][0]} toolCall
 * @param {((params: Record<string, any>) => string)} [actionFormatter]
 * @param {string | null} [cwd]
 * @param {{ oldContent?: string; startLine?: number }} [context]
 * @returns {SendContent | null}
 */
export function formatToolCallDisplay(toolCall, actionFormatter, cwd, context) {
  const args = parseToolArgs(toolCall.arguments);

  const name = toolCall.name;

  const activity = classifyToolActivity(name, args, cwd);
  if (activity) {
    return formatActivitySummary(activity);
  }

  // Bash tool: render command as a syntax-highlighted image with *Bash* prefix.
  if (name === "Bash" && typeof args.command === "string") {
    const summary = getToolCallSummary(name, args, undefined, cwd, context);
    const formatted = formatBashCommand(args.command);
    return [{ type: "code", code: formatted, language: "bash", caption: summary }];
  }

  // SDK built-in tools: compact, human-friendly display
  const sdkDisplay = formatSdkToolCall(name, args, cwd);
  if (sdkDisplay) return sdkDisplay;

  // Edit/Write: render code content as a syntax-highlighted image
  if ((name === "Edit" || name === "Write") && typeof args.file_path === "string") {
    const lang = langFromPath(args.file_path);
    let header = `*${name}*  \`${shortenPath(args.file_path, cwd)}\``;
    if (context?.startLine != null) {
      const lineCount = typeof args.old_string === "string" ? args.old_string.split("\n").length : 1;
      header += lineCount > 1
        ? `  _L${context.startLine}–${context.startLine + lineCount - 1}_`
        : `  _L${context.startLine}_`;
    }
    const displayLang = lang || "text";
    /** @type {ToolContentBlock[]} */
    const blocks = [];
    if (name === "Edit" && typeof args.old_string === "string" && typeof args.new_string === "string") {
      blocks.push({ type: "diff", oldStr: args.old_string, newStr: args.new_string, language: displayLang, caption: header });
    } else if (name === "Write" && context?.oldContent != null && typeof args.content === "string") {
      blocks.push({ type: "diff", oldStr: context.oldContent, newStr: args.content, language: displayLang, caption: header });
    } else if (name === "Write" && typeof args.content === "string" && args.content.trim()) {
      blocks.push({ type: "code", code: args.content, language: displayLang, caption: header });
    } else {
      blocks.push({ type: "text", text: header });
    }
    return blocks;
  }

  // Generic fallback
  let msg = `*${toolCall.name}*`;

  if (actionFormatter) {
    msg += `: ${actionFormatter(args)}`;
  } else {
    const entries = Object.entries(args);
    if (entries.length > 0) {
      const inline = entries.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return entries.length === 1 ? val : `${k}: ${val}`;
      }).join(", ");
      msg += `\n${inline}`;
    }
  }

  return msg;
}
