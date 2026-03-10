/**
 * Pure functions for formatting tool calls and results for WhatsApp display.
 *
 * All functions return `SendContent | null` — the caller decides how to send.
 * `null` means "nothing to display".
 */

import { parseToolArgs } from "./harnesses/index.js";
import { maxCharsForLineCount } from "./code-image-renderer.js";

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
 * Format SDK built-in tool calls (Read, Grep, Glob, WebSearch, WebFetch, Agent)
 * into compact, human-friendly strings. Returns null for unknown tools.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {string | null}
 */
export function formatSdkToolCall(name, args) {
  switch (name) {
    case "Read": {
      const path = typeof args.file_path === "string" ? args.file_path : null;
      if (!path) return null;
      let label = `*Read*  \`${path}\``;
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
      let label = `*Grep*  \`${pattern}\``;
      if (typeof args.path === "string") label += `  in \`${args.path}\``;
      if (typeof args.glob === "string") label += `  (${args.glob})`;
      return label;
    }
    case "Glob": {
      const pattern = typeof args.pattern === "string" ? args.pattern : null;
      if (!pattern) return null;
      let label = `*Glob*  \`${pattern}\``;
      if (typeof args.path === "string") label += `  in \`${args.path}\``;
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
    default:
      return null;
  }
}

/**
 * Wrap a single line at the last space that keeps it under `maxWidth`.
 * Continuation lines are indented with `indent` and the previous line
 * gets a trailing ` \` (bash line continuation) for proper syntax highlighting.
 * If no suitable break point exists (e.g. a single very long token), the line
 * is left as-is.
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
    // Find the last space within the threshold (accounting for " \")
    const breakIdx = remaining.lastIndexOf(" ", wrapWidth);
    if (breakIdx <= 0) break; // no good break point — leave as-is

    wrapped.push(remaining.slice(0, breakIdx) + " \\");
    remaining = indent + remaining.slice(breakIdx + 1);
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
  const parts = firstLine.split(/\s+(\|{1,2}|&&|;)\s+/);

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
  const connectorParts = firstLine.split(/\s+(\|{1,2}|&&|;)\s+/);
  const baseLineCount = Math.ceil(connectorParts.length / 2);

  // Derive max char width from the aspect ratio constraint, capped at 80.
  // More lines → wider allowed; fewer lines → narrower to avoid thin images.
  const maxWidth = Math.min(80, maxCharsForLineCount(baseLineCount));

  return formatWithWidth(firstLine, rest, maxWidth);
}

/**
 * Format a tool call for WhatsApp display. Returns the content to send,
 * or null if nothing should be displayed.
 * @param {LlmChatResponse['toolCalls'][0]} toolCall
 * @param {boolean} isDebug
 * @param {((params: Record<string, any>) => string)} [actionFormatter]
 * @returns {SendContent | null}
 */
export function formatToolCallDisplay(toolCall, isDebug, actionFormatter) {
  const args = parseToolArgs(toolCall.arguments);

  // Non-debug: show only the description when available
  if (!isDebug) {
    const description = typeof args.description === "string" ? args.description : null;
    if (description) return description;
  }

  const name = toolCall.name;

  // Bash tool: render command as a syntax-highlighted image with description as caption.
  if (name === "Bash" && typeof args.command === "string") {
    const desc = typeof args.description === "string" ? args.description : null;
    const formatted = formatBashCommand(args.command);
    const caption = desc ? `*${desc}*` : null;
    return [{ type: "code", code: formatted, language: "bash", ...(caption && { caption }) }];
  }

  // SDK built-in tools: compact, human-friendly display
  const sdkDisplay = formatSdkToolCall(name, args);
  if (sdkDisplay) return sdkDisplay;

  // Edit/Write: render code content as a syntax-highlighted image
  if ((name === "Edit" || name === "Write") && typeof args.file_path === "string") {
    const lang = langFromPath(args.file_path);
    const header = `*${name}*  \`${args.file_path}\``;
    /** @type {ToolContentBlock[]} */
    const blocks = [];
    if (name === "Edit" && typeof args.old_string === "string" && typeof args.new_string === "string" && lang) {
      blocks.push({ type: "diff", oldStr: args.old_string, newStr: args.new_string, language: lang, caption: header });
    } else if (name === "Write" && typeof args.content === "string" && args.content.trim() && lang) {
      blocks.push({ type: "code", code: args.content, language: lang, caption: header });
    } else {
      blocks.push({ type: "text", text: header });
    }
    return blocks;
  }

  // Generic fallback
  let msg = isDebug ? `*${toolCall.name}*` : toolCall.name;

  if (actionFormatter) {
    msg += `: ${actionFormatter(args)}`;
  } else {
    const entries = Object.entries(args);
    if (entries.length > 0) {
      const inline = entries.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return entries.length === 1 ? val : `${k}: ${val}`;
      }).join(", ");
      if (isDebug) {
        msg += `\n${inline}`;
      } else if (inline.length <= 80) {
        msg += `: ${inline}`;
      }
    }
  }

  return msg;
}

/**
 * Format a tool result for WhatsApp display. Returns the content to send
 * (as "tool-result"), or null if nothing should be displayed.
 *
 * For debug mode, returns `{ source: "send", content }`.
 * For final answers (non-autoContinue), returns `{ source: "reply", content }`.
 * This lets the caller choose between `send` and `reply`.
 *
 * @param {ToolContentBlock[]} blocks
 * @param {string} toolName
 * @param {Action['permissions']} permissions
 * @param {boolean} isDebug
 * @returns {{ source: "send" | "reply", content: SendContent }[] | null}
 */
export function formatToolResultDisplay(blocks, toolName, permissions, isDebug) {
  if (permissions.silent) return null;

  const textBlocks = blocks.filter(b => b.type === "text");
  const nonTextBlocks = blocks.filter(b => b.type !== "text");

  if (isDebug) {
    const textSummary = textBlocks.map(b => /** @type {TextContentBlock} */ (b).text).join("\n");
    /** @type {{ source: "send" | "reply", content: SendContent }[]} */
    const result = [{ source: "send", content: `${toolName}: ${textSummary || "Done."}` }];
    if (nonTextBlocks.length > 0) result.push({ source: "send", content: nonTextBlocks });
    return result;
  }

  if (permissions.autoContinue) {
    if (nonTextBlocks.length > 0) return [{ source: "send", content: nonTextBlocks }];
    return null;
  }

  // Final answer: render all blocks
  return [{ source: "reply", content: blocks }];
}
