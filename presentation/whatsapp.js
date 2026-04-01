/**
 * WhatsApp-specific tool presentation policy.
 */

import { maxCharsForLineCount } from "../code-image-renderer.js";
import { formatStructuredInspectOutput } from "../tool-inspect-formatters.js";
import { buildToolPresentation } from "../tool-presentation-model.js";

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
 * Minimum number of characters the longest line must shrink by for a wrap
 * to be worthwhile.
 */
const MIN_WRAP_GAIN = 4;

/**
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
  const wrapWidth = maxWidth - 2;

  while (remaining.length > maxWidth) {
    const contentStart = remaining.length - remaining.trimStart().length;
    const breakIdx = remaining.lastIndexOf(" ", wrapWidth);

    if (breakIdx > contentStart) {
      const continuationLen = indent.length + remaining.length - breakIdx - 1;
      if (remaining.length - continuationLen < MIN_WRAP_GAIN) {
        break;
      }
      wrapped.push(remaining.slice(0, breakIdx) + " \\");
      remaining = indent + remaining.slice(breakIdx + 1);
    } else {
      const continuationLen = indent.length + remaining.length - wrapWidth;
      if (remaining.length - continuationLen < MIN_WRAP_GAIN) {
        break;
      }
      wrapped.push(remaining.slice(0, wrapWidth) + "\\");
      remaining = indent + remaining.slice(wrapWidth);
    }
  }

  wrapped.push(remaining);
  return wrapped.join("\n");
}

/**
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
  for (let index = 1; index < parts.length; index += 2) {
    const connector = parts[index];
    const segment = parts[index + 1] ?? "";
    result += "\n" + wrapLongLine(`  ${connector} ${segment}`, "      ", maxWidth);
  }
  return result + rest;
}

/**
 * @param {string} command
 * @returns {string}
 */
export function formatBashCommand(command) {
  const newlineIdx = command.indexOf("\n");
  const firstLine = newlineIdx === -1 ? command : command.slice(0, newlineIdx);
  const rest = newlineIdx === -1 ? "" : command.slice(newlineIdx);
  const connectorParts = firstLine.split(/\s*(\|{1,2}|&&|;)\s+/);
  const baseLineCount = Math.ceil(connectorParts.length / 2);
  const maxWidth = Math.min(80, maxCharsForLineCount(baseLineCount));
  return formatWithWidth(firstLine, rest, maxWidth);
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatReadInspectOutput(text) {
  const stripped = text.replace(/^\s*\d+[\t→]\s?/gm, "");
  return `\`\`\`\n${stripped}\n\`\`\``;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatGrepInspectOutput(text) {
  const lines = text.split("\n");
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  const pattern = /^(.+?):(\d+)([:-])(.*)$/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) {
      if (line.trim()) {
        const fallback = groups.get("__other__") ?? [];
        fallback.push(line);
        groups.set("__other__", fallback);
      }
      continue;
    }

    const [, filePath, lineNum, , content] = match;
    const fileLines = groups.get(filePath) ?? [];
    fileLines.push(`${lineNum}: ${content.trim()}`);
    groups.set(filePath, fileLines);
  }

  if (groups.size === 0) {
    return text;
  }

  /** @type {string[]} */
  const parts = [];
  for (const [filePath, fileLines] of groups) {
    if (filePath === "__other__") {
      parts.push(fileLines.join("\n"));
      continue;
    }
    parts.push(`*${filePath}*\n\`\`\`\n${fileLines.join("\n")}\n\`\`\``);
  }
  return parts.join("\n\n");
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatGlobInspectOutput(text) {
  const paths = text.split("\n").filter((line) => line.trim());
  if (paths.length === 0) {
    return "_no files_";
  }
  return `_${paths.length} file${paths.length === 1 ? "" : "s"}_\n\`\`\`\n${paths.join("\n")}\n\`\`\``;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatBashInspectOutput(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "stdout" in parsed) {
      /** @type {string[]} */
      const parts = [];
      const record = /** @type {{ stdout?: unknown, stderr?: unknown }} */ (parsed);
      if (typeof record.stdout === "string" && record.stdout.trim()) {
        parts.push(record.stdout.trim());
      }
      if (typeof record.stderr === "string" && record.stderr.trim()) {
        parts.push(`_stderr:_\n${record.stderr.trim()}`);
      }
      return parts.length > 0 ? parts.join("\n\n") : "_no output_";
    }
  } catch {
    // Ignore parse failures and fall through to the raw text.
  }
  return text;
}

/**
 * @param {string} text
 * @param {import("../tool-presentation-model.js").ToolInspectMode} inspectMode
 * @returns {string}
 */
function formatInspectOutput(text, inspectMode) {
  switch (inspectMode) {
    case "read":
      return formatReadInspectOutput(text);
    case "grep":
      return formatGrepInspectOutput(text);
    case "glob":
      return formatGlobInspectOutput(text);
    case "bash":
      return formatBashInspectOutput(text);
    default:
      return formatStructuredInspectOutput(text, inspectMode);
  }
}

/**
 * @param {import("../tool-presentation-model.js").PlanPresentation} presentation
 * @returns {string[]}
 */
function buildPlanInspectLines(presentation) {
  /** @type {string[]} */
  const lines = [];
  if (presentation.explanation) {
    lines.push(`_${presentation.explanation}_`);
  }
  for (const entry of presentation.entries) {
    switch (entry.status) {
      case "completed":
        lines.push(`[x] ${entry.text}`);
        break;
      case "in_progress":
        lines.push(`[~] ${entry.text}`);
        break;
      case "pending":
        lines.push(`[ ] ${entry.text}`);
        break;
      default:
        lines.push(`[-] ${entry.text}`);
        break;
    }
  }
  return lines;
}

/**
 * @param {import("../tool-presentation-model.js").PlanPresentation} presentation
 * @returns {string}
 */
export function formatPlanPresentationText(presentation) {
  const lines = buildPlanInspectLines(presentation);
  const hasExplanation = typeof presentation.explanation === "string" && presentation.explanation.length > 0;
  const hasEntries = presentation.entries.length > 0;
  return lines.length > 0
    ? [
      "*Plan*",
      "",
      ...lines.slice(0, hasExplanation && hasEntries ? 1 : lines.length),
      ...(hasExplanation && hasEntries ? [""] : []),
      ...(hasExplanation && hasEntries ? lines.slice(1) : []),
    ].join("\n")
    : "*Plan*";
}

/**
 * @param {string} command
 * @param {string | undefined} output
 * @param {import("../tool-presentation-model.js").ToolInspectMode} inspectMode
 * @returns {string}
 */
export function formatCommandInspectText(command, output, inspectMode) {
  const body = output != null && output.length > 0
    ? formatInspectOutput(output, inspectMode)
    : "_no output_";
  return [
    "```bash",
    command,
    "```",
    "",
    body,
  ].join("\n");
}

/**
 * @param {import("../tool-presentation-model.js").ToolPresentation} presentation
 * @returns {string}
 */
export function formatToolPresentationSummary(presentation) {
  return presentation.summary;
}

/**
 * @param {import("../tool-presentation-model.js").ToolPresentation} presentation
 * @returns {SendContent | null}
 */
export function formatToolPresentationDisplay(presentation) {
  switch (presentation.kind) {
    case "activity":
    case "plan":
      return presentation.summary;
    case "bash":
      return [{
        type: "code",
        code: formatBashCommand(presentation.command),
        language: "bash",
        caption: presentation.summary,
      }];
    case "file": {
      const displayLang = langFromPath(presentation.filePath) || "text";
      if (
        presentation.toolName === "Edit"
        && typeof presentation.oldString === "string"
        && typeof presentation.newString === "string"
      ) {
        return [{
          type: "diff",
          oldStr: presentation.oldString,
          newStr: presentation.newString,
          language: displayLang,
          caption: presentation.summary,
        }];
      }
      if (
        presentation.toolName === "Write"
        && typeof presentation.oldContent === "string"
        && typeof presentation.content === "string"
      ) {
        return [{
          type: "diff",
          oldStr: presentation.oldContent,
          newStr: presentation.content,
          language: displayLang,
          caption: presentation.summary,
        }];
      }
      if (presentation.toolName === "Write" && typeof presentation.content === "string" && presentation.content.trim()) {
        return [{
          type: "code",
          code: presentation.content,
          language: displayLang,
          caption: presentation.summary,
        }];
      }
      return [{ type: "text", text: presentation.summary }];
    }
    case "generic":
      return presentation.summary.startsWith("*")
        ? presentation.summary
        : `*${presentation.toolName}*: ${presentation.summary}`;
    default:
      return null;
  }
}

/**
 * @param {import("../tool-presentation-model.js").ToolPresentation} presentation
 * @param {string | undefined} output
 * @returns {string | null}
 */
export function formatToolPresentationInspect(presentation, output) {
  switch (presentation.kind) {
    case "activity":
      return typeof output === "string" && output.length > 0
        ? formatInspectOutput(output, presentation.inspectMode)
        : "_no output_";
    case "plan": {
      const lines = buildPlanInspectLines(presentation);
      const trimmedOutput = typeof output === "string" ? output.trim() : "";
      const planText = presentation.entries.map((entry) => entry.text).join("\n");
      const includeOutput = trimmedOutput.length > 0 && trimmedOutput !== planText;
      if (lines.length === 0) {
        return includeOutput ? trimmedOutput : null;
      }
      return includeOutput ? [...lines, "", trimmedOutput].join("\n") : lines.join("\n");
    }
    case "bash":
      return formatCommandInspectText(presentation.command, output, presentation.inspectMode);
    case "generic":
      return typeof output === "string" && output.length > 0
        ? formatInspectOutput(output, "plain")
        : null;
    default:
      return null;
  }
}

/**
 * Convenience wrapper for call sites that still pass raw tool metadata.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {((params: Record<string, unknown>) => string) | undefined} formatToolCall
 * @param {string | null | undefined} cwd
 * @param {{ oldContent?: string; startLine?: number } | undefined} context
 * @returns {SendContent | null}
 */
export function formatToolDisplay(name, args, formatToolCall, cwd, context) {
  return formatToolPresentationDisplay(buildToolPresentation(name, args, formatToolCall, cwd, context));
}
