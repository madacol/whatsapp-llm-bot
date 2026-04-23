import { MIN_ROWS_FOR_TABLE_IMAGE } from "./code-image-renderer.js";
import { splitDisplayMathBlocks } from "./markdown-display-math.js";

/** Regex matching the separator row of a markdown table. */
const TABLE_SEP_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/**
 * @typedef {
 *   | { kind: "text", text: string }
 *   | { kind: "code_block", language: string, code: string }
 *   | { kind: "table", text: string }
 *   | { kind: "display_math", tex: string, rawText: string }
 *   | { kind: "attachment_directive", path: string, rawText: string, caption?: string }
 * } MarkdownSegment
 */

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeDirectiveValue(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const startsWithQuote = trimmed.startsWith("\"") || trimmed.startsWith("'");
  const endsWithQuote = trimmed.endsWith("\"") || trimmed.endsWith("'");
  if (startsWithQuote && endsWithQuote && trimmed[0] === trimmed[trimmed.length - 1]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * @param {string} code
 * @param {string} rawText
 * @returns {MarkdownSegment | null}
 */
function parseAttachmentDirective(code, rawText) {
  /** @type {{ path?: string, caption?: string }} */
  const parsed = {};

  for (const line of code.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.+)$/i);
    if (!match) {
      return null;
    }

    const key = match[1].toLowerCase();
    const value = normalizeDirectiveValue(match[2]);
    if (key === "path") {
      parsed.path = value;
      continue;
    }
    if (key === "caption") {
      parsed.caption = value;
      continue;
    }
    return null;
  }

  if (!parsed.path) {
    return null;
  }

  return {
    kind: "attachment_directive",
    path: parsed.path,
    rawText,
    ...(parsed.caption ? { caption: parsed.caption } : {}),
  };
}

/**
 * Split a text segment into interleaved text and table segments.
 * A markdown table is: header row -> separator row -> 1+ data rows,
 * where every line contains at least one `|`.
 * @param {string} text
 * @returns {Array<{ kind: "text" | "table", text: string }>}
 */
function splitTables(text) {
  const lines = text.split("\n");
  /** @type {Array<{ kind: "text" | "table", text: string }>} */
  const segments = [];
  /** @type {string[]} */
  let textLines = [];

  const flushTextLines = () => {
    if (textLines.length > 0) {
      segments.push({ kind: "text", text: textLines.join("\n") });
      textLines = [];
    }
  };

  let index = 0;
  while (index < lines.length) {
    if (
      index + 2 < lines.length &&
      lines[index].includes("|") &&
      TABLE_SEP_RE.test(lines[index + 1])
    ) {
      /** @type {string[]} */
      const tableLines = [lines[index], lines[index + 1]];
      let nextIndex = index + 2;

      while (nextIndex < lines.length && lines[nextIndex].includes("|") && !TABLE_SEP_RE.test(lines[nextIndex])) {
        tableLines.push(lines[nextIndex]);
        nextIndex += 1;
      }

      const dataRowCount = tableLines.length - 2;
      if (dataRowCount >= MIN_ROWS_FOR_TABLE_IMAGE) {
        flushTextLines();
        segments.push({ kind: "table", text: tableLines.join("\n") });
      } else {
        textLines.push(...tableLines);
      }

      index = nextIndex;
      continue;
    }

    textLines.push(lines[index]);
    index += 1;
  }

  flushTextLines();
  return segments;
}

/**
 * Segment markdown in render order so downstream rendering can stay simple.
 * The parser is intentionally conservative and only recognizes the markdown
 * constructs that already have dedicated WhatsApp render behavior.
 * @param {string} text
 * @returns {MarkdownSegment[]}
 */
export function segmentMarkdown(text) {
  const parts = text.split(/(```\w*\n[\s\S]*?```)/g);
  /** @type {MarkdownSegment[]} */
  const segments = [];

  for (const part of parts) {
    const codeMatch = part.match(/^```(\w*)\n([\s\S]*?)```$/);
    if (codeMatch) {
      if ((codeMatch[1] || "").toLowerCase() === "attachment") {
        const attachmentDirective = parseAttachmentDirective(codeMatch[2].trim(), part);
        if (attachmentDirective) {
          segments.push(attachmentDirective);
          continue;
        }
      }

      segments.push({
        kind: "code_block",
        language: codeMatch[1] || "",
        code: codeMatch[2].trimEnd(),
      });
      continue;
    }

    const tableSegments = splitTables(part);
    for (const tableSegment of tableSegments) {
      if (tableSegment.kind === "table") {
        segments.push(tableSegment);
        continue;
      }

      const mathSegments = splitDisplayMathBlocks(tableSegment.text);
      for (const mathSegment of mathSegments) {
        if (mathSegment.kind === "display_math") {
          segments.push(mathSegment);
          continue;
        }
        segments.push({ kind: "text", text: mathSegment.text });
      }
    }
  }

  return segments;
}
