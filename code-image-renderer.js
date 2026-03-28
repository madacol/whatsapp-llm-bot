import { createHighlighter } from "shiki";
import { Resvg } from "@resvg/resvg-js";
import { diffLines } from "diff";
import { createLogger } from "./logger.js";

const log = createLogger("code-image-renderer");

export const MIN_LINES_FOR_IMAGE = 5;
const FONT_SIZE = 14;
const LINE_HEIGHT = 20;
const PADDING = 16;
const CHAR_WIDTH = FONT_SIZE * 0.6;
const MIN_WRAP_CHARS = 20;

/**
 * Maximum image aspect ratio (width:height) before WhatsApp crops or
 * renders the image too small. A ratio of ~6:1 keeps code images readable
 * on mobile without being excessively wide.
 *
 * At 6:1: 1 line → 33 chars, 2 → 47, 3 → 61, 5+ → 80 (capped by caller).
 */
const MAX_ASPECT_RATIO = 6;
const DIFF_MAX_ASPECT_RATIO = 2;
const MAX_PIXELS = 12_500_000;
const MAX_SVG_WIDTH = 4000;
const MAX_LINES_PER_CHUNK = 100;
const DIFF_MAX_SVG_WIDTH = 2000;
const DIFF_MAX_LINES_PER_CHUNK = 50;

/**
 * Compute the maximum number of characters per line that keeps the rendered
 * code image within the target aspect ratio for the given number of lines.
 * Returns Infinity when the line count is high enough that no wrapping is needed.
 * @param {number} lineCount
 * @returns {number}
 */
export function maxCharsForLineCount(lineCount) {
  return maxCharsForLayout(lineCount, { maxAspectRatio: MAX_ASPECT_RATIO });
}

/**
 * Compute the maximum number of content characters per line for a given layout.
 * @param {number} lineCount
 * @param {{ maxAspectRatio: number, gutterWidth?: number, prefixChars?: number }} options
 * @returns {number}
 */
function maxCharsForLayout(lineCount, options) {
  const height = lineCount * LINE_HEIGHT + PADDING * 2;
  const maxWidth = options.maxAspectRatio * height;
  const gutterWidth = options.gutterWidth ?? 0;
  const prefixChars = options.prefixChars ?? 0;
  const maxChars = Math.floor((maxWidth - PADDING * 2 - gutterWidth) / CHAR_WIDTH) - prefixChars;
  return Math.max(maxChars, MIN_WRAP_CHARS);
}
const GUTTER_WIDTH = 28; // Width for the +/- prefix gutter in diffs
const FONT_FAMILY = "DejaVu Sans Mono";
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
const THEME = "github-dark";
const BG_COLOR = "#0d1117";

// Diff line background colors (GitHub-dark style, semi-transparent)
const DIFF_ADD_BG = "rgba(46, 160, 67, 0.15)";
const DIFF_DEL_BG = "rgba(248, 81, 73, 0.15)";
const DIFF_ADD_GUTTER = "#2ea04380";
const DIFF_DEL_GUTTER = "#f8514980";

// Table rendering constants
const TABLE_HEADER_BG = "#161b22";
const TABLE_CELL_PADDING_H = 12;
const TABLE_CELL_PADDING_V = 4;
const TABLE_BORDER_COLOR = "#30363d";
const TEXT_COLOR = "#e6edf3";
const BOLD_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf";
export const MIN_ROWS_FOR_TABLE_IMAGE = 3;

/** @type {Awaited<ReturnType<typeof createHighlighter>> | null} */
let highlighter = null;

/**
 * Get or create a lazy-initialized shiki highlighter.
 * @returns {Promise<Awaited<ReturnType<typeof createHighlighter>>>}
 */
async function getHighlighter() {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: [THEME],
      langs: [],
    });
  }
  return highlighter;
}

/**
 * Escape text for safe SVG inclusion.
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Estimate the width of a string in the monospace font.
 * @param {string} text
 * @returns {number}
 */
function estimateTextWidth(text) {
  // Monospace: each character is roughly 0.6 * fontSize wide
  return text.length * FONT_SIZE * 0.6;
}

/**
 * Load a language into the highlighter if not already loaded.
 * @param {Awaited<ReturnType<typeof createHighlighter>>} hl
 * @param {string} lang
 * @returns {Promise<string>} The effective language (falls back to "text")
 */
async function loadLang(hl, lang) {
  const loadedLangs = hl.getLoadedLanguages();
  if (!loadedLangs.includes(lang)) {
    try {
      await hl.loadLanguage(/** @type {import("shiki").BundledLanguage} */ (lang));
    } catch {
      // Fall back to plain text if language not supported
    }
  }
  return hl.getLoadedLanguages().includes(lang) ? lang : "text";
}

/**
 * @typedef {{ tokens: import("shiki").ThemedToken[]; bg?: string; gutter?: string; prefix?: string }} AnnotatedLine
 */

/**
 * @typedef {{
 *   gutterWidth?: number,
 *   maxPixels?: number,
 *   maxSvgWidth?: number,
 *   maxLinesPerChunk?: number,
 * }} AnnotatedLineRenderOptions
 */

/**
 * Render annotated token lines into PNG image buffers.
 * Each line can have an optional background color, gutter color, and prefix character.
 * @param {AnnotatedLine[]} lines
 * @param {AnnotatedLineRenderOptions} [opts]
 * @returns {Buffer[]}
 */
function renderAnnotatedLines(lines, opts) {
  const gutterWidth = opts?.gutterWidth ?? 0;
  const contentX = PADDING + gutterWidth;
  const maxPixels = opts?.maxPixels ?? MAX_PIXELS;
  const maxSvgWidth = opts?.maxSvgWidth ?? MAX_SVG_WIDTH;
  const maxLinesPerChunkLimit = opts?.maxLinesPerChunk ?? MAX_LINES_PER_CHUNK;

  // Compute image width from the widest line across ALL lines so chunks
  // share a consistent width and we can derive an adaptive chunk size.
  let maxLineWidth = 0;
  for (const line of lines) {
    const lineText = (line.prefix || "") + line.tokens.map(t => t.content).join("");
    const width = estimateTextWidth(lineText);
    if (width > maxLineWidth) maxLineWidth = width;
  }
  const svgWidth = Math.min(Math.max(maxLineWidth + contentX + PADDING, 200), maxSvgWidth);

  // Adaptive chunk size: fit as many lines as the pixel budget allows,
  // but cap at 100 lines for readability on mobile screens.
  const maxLinesPerChunk = Math.min(
    maxLinesPerChunkLimit,
    Math.max(10, Math.floor((maxPixels / svgWidth - PADDING * 2) / LINE_HEIGHT)),
  );

  /** @type {AnnotatedLine[][]} */
  const chunks = [];
  for (let i = 0; i < lines.length; i += maxLinesPerChunk) {
    chunks.push(lines.slice(i, i + maxLinesPerChunk));
  }

  /** @type {Buffer[]} */
  const images = [];

  for (const chunk of chunks) {
    const svgHeight = chunk.length * LINE_HEIGHT + PADDING * 2;

    // Build SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">`;
    svg += `<rect width="100%" height="100%" fill="${BG_COLOR}" rx="8"/>`;

    for (let lineIdx = 0; lineIdx < chunk.length; lineIdx++) {
      const line = chunk[lineIdx];
      const y = PADDING + lineIdx * LINE_HEIGHT;
      const textY = y + LINE_HEIGHT - 4;

      // Line background highlight for diff lines
      if (line.bg) {
        svg += `<rect x="0" y="${y}" width="100%" height="${LINE_HEIGHT}" fill="${line.bg}"/>`;
      }

      // Gutter (prefix column with +/- sign)
      if (gutterWidth > 0 && line.prefix) {
        if (line.gutter) {
          svg += `<rect x="0" y="${y}" width="${PADDING + gutterWidth}" height="${LINE_HEIGHT}" fill="${line.gutter}"/>`;
        }
        const prefixColor = line.prefix === "+" ? "#3fb950" : line.prefix === "-" ? "#f85149" : "#8b949e";
        svg += `<text x="${PADDING}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${prefixColor}" xml:space="preserve">${escapeXml(line.prefix)}</text>`;
      }

      // Code tokens
      svg += `<text x="${contentX}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="#e6edf3" xml:space="preserve">`;
      for (const token of line.tokens) {
        const color = token.color || "#e6edf3";
        svg += `<tspan fill="${color}">${escapeXml(token.content)}</tspan>`;
      }
      svg += `</text>`;
    }

    svg += `</svg>`;

    const resvg = new Resvg(svg, {
      font: {
        fontFiles: [FONT_PATH],
        loadSystemFonts: false,
      },
    });
    const pngData = resvg.render();
    images.push(Buffer.from(pngData.asPng()));
  }

  return images;
}

/**
 * Render code as syntax-highlighted PNG image(s).
 * Splits long code across multiple images at MAX_LINES_PER_IMAGE.
 * @param {string} code
 * @param {string} [language]
 * @returns {Promise<Buffer[]>}
 */
export async function renderCodeToImages(code, language) {
  const hl = await getHighlighter();
  const effectiveLang = await loadLang(hl, language || "text");

  const result = hl.codeToTokens(code, { lang: /** @type {import("shiki").BundledLanguage} */ (effectiveLang), theme: THEME });

  /** @type {AnnotatedLine[]} */
  const lines = result.tokens.map(tokens => ({ tokens }));

  // Strip trailing empty lines (e.g. from trailing newlines in the source)
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const text = last.tokens.map(t => t.content).join("");
    if (text.trim()) break;
    lines.pop();
  }

  if (lines.length === 0) {
    log.warn("renderCodeToImages called with empty code, skipping image render");
    return [];
  }

  return renderAnnotatedLines(lines);
}

/**
 * Render a diff (old_string → new_string) as syntax-highlighted PNG image(s).
 * Removed lines show with red background, added lines with green background,
 * each with a +/- gutter prefix. Both sides are highlighted in the target language.
 * @param {string} oldStr
 * @param {string} newStr
 * @param {string} [language]
 * @returns {Promise<Buffer[]>}
 */
/**
 * @typedef {"left" | "center" | "right"} ColumnAlignment
 */

/**
 * @typedef {{
 *   headers: string[],
 *   alignments: ColumnAlignment[],
 *   rows: string[][],
 * }} ParsedTable
 */

/**
 * Parse a markdown table string into structured data.
 * @param {string} markdown
 * @returns {ParsedTable}
 */
function parseMarkdownTable(markdown) {
  const rawLines = markdown.split("\n").filter(l => l.trim());
  if (rawLines.length < 2) return { headers: [], alignments: [], rows: [] };

  /** @param {string} line */
  const splitRow = (line) => {
    const trimmed = line.trim();
    // Remove leading/trailing pipe, split by |, trim cells
    const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
    const chopped = inner.endsWith("|") ? inner.slice(0, -1) : inner;
    // Handle escaped pipes: replace \| with a placeholder, split, then restore
    return chopped
      .replace(/\\\|/g, "\x00")
      .split("|")
      .map(cell => cell.replace(/\x00/g, "|").trim());
  };

  const headers = splitRow(rawLines[0]);

  /** @type {ColumnAlignment[]} */
  const alignments = splitRow(rawLines[1]).map(cell => {
    const t = cell.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    return "left";
  });

  // Pad alignments to match header count
  while (alignments.length < headers.length) alignments.push("left");

  /** @type {string[][]} */
  const rows = [];
  for (let i = 2; i < rawLines.length; i++) {
    const cells = splitRow(rawLines[i]);
    // Pad or truncate to header count
    while (cells.length < headers.length) cells.push("");
    rows.push(cells.slice(0, headers.length));
  }

  return { headers, alignments, rows };
}

/**
 * Render a markdown table as a styled PNG image.
 * Uses the same dark theme as code blocks, with grid lines and header styling.
 * @param {string} markdownTable
 * @returns {Buffer[]}
 */
export function renderTableToImages(markdownTable) {
  const { headers, alignments, rows } = parseMarkdownTable(markdownTable);
  if (headers.length === 0 || rows.length === 0) return [];

  // ── measure column widths ─────────────────────────────────────────
  const MAX_SVG_WIDTH = 4000;
  const MAX_PIXELS = 12_500_000;
  const MAX_LINES_PER_CHUNK = 100;

  /** @type {number[]} */
  const colWidths = headers.map((h, i) => {
    let maxLen = h.length;
    for (const row of rows) {
      if (row[i].length > maxLen) maxLen = row[i].length;
    }
    return maxLen * CHAR_WIDTH + TABLE_CELL_PADDING_H * 2;
  });

  // Enforce minimum column width
  const MIN_COL_WIDTH = 50;
  for (let i = 0; i < colWidths.length; i++) {
    if (colWidths[i] < MIN_COL_WIDTH) colWidths[i] = MIN_COL_WIDTH;
  }

  const tableContentWidth = colWidths.reduce((a, b) => a + b, 0);
  const svgWidth = Math.min(tableContentWidth + PADDING * 2, MAX_SVG_WIDTH);

  // Scale columns if table is too wide
  if (tableContentWidth + PADDING * 2 > MAX_SVG_WIDTH) {
    const scale = (MAX_SVG_WIDTH - PADDING * 2) / tableContentWidth;
    for (let i = 0; i < colWidths.length; i++) {
      colWidths[i] = Math.max(MIN_COL_WIDTH, Math.floor(colWidths[i] * scale));
    }
  }

  // ── chunk rows ────────────────────────────────────────────────────
  const rowHeight = LINE_HEIGHT + TABLE_CELL_PADDING_V;
  const maxRowsPerChunk = Math.min(
    MAX_LINES_PER_CHUNK,
    Math.max(10, Math.floor((MAX_PIXELS / svgWidth - PADDING * 2) / rowHeight) - 1),
  );

  /** @type {string[][][]} */
  const chunks = [];
  for (let i = 0; i < rows.length; i += maxRowsPerChunk) {
    chunks.push(rows.slice(i, i + maxRowsPerChunk));
  }

  /** @type {Buffer[]} */
  const images = [];

  for (const chunk of chunks) {
    const totalRows = 1 + chunk.length; // header + data rows
    const svgHeight = totalRows * rowHeight + PADDING * 2;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">`;
    svg += `<rect width="100%" height="100%" fill="${BG_COLOR}" rx="8"/>`;

    /**
     * Draw a row of text cells.
     * @param {string[]} cells
     * @param {number} rowIdx — 0-based row index in this chunk (0 = header)
     * @param {boolean} isHeader
     */
    const drawRow = (cells, rowIdx, isHeader) => {
      const y = PADDING + rowIdx * rowHeight;
      const textY = y + rowHeight - TABLE_CELL_PADDING_V - 2;

      // Header background
      if (isHeader) {
        svg += `<rect x="${PADDING}" y="${y}" width="${svgWidth - PADDING * 2}" height="${rowHeight}" fill="${TABLE_HEADER_BG}"/>`;
      }

      let x = PADDING;
      for (let col = 0; col < headers.length; col++) {
        const cellText = (cells[col] ?? "").slice(0, Math.floor((colWidths[col] - TABLE_CELL_PADDING_H * 2) / CHAR_WIDTH));
        const truncated = cellText.length < (cells[col] ?? "").length;
        const display = truncated ? cellText.slice(0, -1) + "…" : cellText;
        const align = alignments[col] ?? "left";

        let textX;
        /** @type {string} */
        let anchor;
        if (align === "center") {
          textX = x + colWidths[col] / 2;
          anchor = "middle";
        } else if (align === "right") {
          textX = x + colWidths[col] - TABLE_CELL_PADDING_H;
          anchor = "end";
        } else {
          textX = x + TABLE_CELL_PADDING_H;
          anchor = "start";
        }

        const weight = isHeader ? ` font-weight="bold"` : "";
        svg += `<text x="${textX}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${TEXT_COLOR}" text-anchor="${anchor}"${weight} xml:space="preserve">${escapeXml(display)}</text>`;

        x += colWidths[col];
      }
    };

    // Draw header
    drawRow(headers, 0, true);

    // Header separator (thicker)
    const sepY = PADDING + rowHeight;
    svg += `<line x1="${PADDING}" y1="${sepY}" x2="${svgWidth - PADDING}" y2="${sepY}" stroke="${TABLE_BORDER_COLOR}" stroke-width="2"/>`;

    // Draw data rows
    for (let r = 0; r < chunk.length; r++) {
      drawRow(chunk[r], r + 1, false);

      // Row separator
      if (r < chunk.length - 1) {
        const lineY = PADDING + (r + 2) * rowHeight;
        svg += `<line x1="${PADDING}" y1="${lineY}" x2="${svgWidth - PADDING}" y2="${lineY}" stroke="${TABLE_BORDER_COLOR}" stroke-width="1"/>`;
      }
    }

    // Vertical column separators
    let vx = PADDING;
    for (let col = 0; col < headers.length - 1; col++) {
      vx += colWidths[col];
      svg += `<line x1="${vx}" y1="${PADDING}" x2="${vx}" y2="${PADDING + totalRows * rowHeight}" stroke="${TABLE_BORDER_COLOR}" stroke-width="1"/>`;
    }

    svg += `</svg>`;

    const resvg = new Resvg(svg, {
      font: {
        fontFiles: [FONT_PATH, BOLD_FONT_PATH],
        loadSystemFonts: false,
      },
    });
    const pngData = resvg.render();
    images.push(Buffer.from(pngData.asPng()));
  }

  return images;
}

/**
 * Render a diff (old_string → new_string) as syntax-highlighted PNG image(s).
 * Removed lines show with red background, added lines with green background,
 * each with a +/- gutter prefix. Both sides are highlighted in the target language.
 * @param {string} oldStr
 * @param {string} newStr
 * @param {string} [language]
 * @returns {Promise<Buffer[]>}
 */
export async function renderDiffToImages(oldStr, newStr, language) {
  const hl = await getHighlighter();
  const effectiveLang = await loadLang(hl, language || "text");
  const shikiLang = /** @type {import("shiki").BundledLanguage} */ (effectiveLang);

  // Normalize trailing whitespace before diffing — prevents false "changed"
  // lines caused by invisible trailing spaces the LLM may add or remove.
  const norm = (/** @type {string} */ s) => s.split("\n").map(l => l.trimEnd()).join("\n");
  const changes = diffLines(norm(oldStr), norm(newStr));

  // Build a single unified string for each "side" so shiki tokenizes with
  // full context, then slice out the token lines per-change.
  // We assemble the full text first, track line ranges, then tokenize once.
  /** @type {{ kind: "add" | "del" | "ctx"; text: string }[]} */
  const diffParts = [];
  for (const change of changes) {
    const text = change.value.endsWith("\n") ? change.value.slice(0, -1) : change.value;
    if (change.added) {
      diffParts.push({ kind: "add", text });
    } else if (change.removed) {
      diffParts.push({ kind: "del", text });
    } else {
      diffParts.push({ kind: "ctx", text });
    }
  }

  // Tokenize the full combined text so syntax highlighting is correct across boundaries
  const fullText = diffParts.map(p => p.text).join("\n");
  const allTokens = hl.codeToTokens(fullText, { lang: shikiLang, theme: THEME }).tokens;

  // Map token lines back to diff parts
  /** @type {AnnotatedLine[]} */
  const lines = [];
  let tokenLineIdx = 0;

  for (const part of diffParts) {
    const partLineCount = part.text.split("\n").length;
    for (let i = 0; i < partLineCount && tokenLineIdx < allTokens.length; i++, tokenLineIdx++) {
      const tokens = allTokens[tokenLineIdx];
      if (part.kind === "del") {
        lines.push({ tokens, bg: DIFF_DEL_BG, gutter: DIFF_DEL_GUTTER, prefix: "-" });
      } else if (part.kind === "add") {
        lines.push({ tokens, bg: DIFF_ADD_BG, gutter: DIFF_ADD_GUTTER, prefix: "+" });
      } else {
        lines.push({ tokens, prefix: " " });
      }
    }
  }

  return renderDiffAnnotatedLines(lines);
}

/**
 * Render a unified diff as syntax-highlighted PNG image(s), preserving the
 * existing hunk boundaries and context lines instead of re-diffing full files.
 * @param {string} diffText
 * @param {string} [language]
 * @returns {Promise<Buffer[]>}
 */
export async function renderUnifiedDiffToImages(diffText, language) {
  const hl = await getHighlighter();
  const effectiveLang = await loadLang(hl, language || "text");
  const shikiLang = /** @type {import("shiki").BundledLanguage} */ (effectiveLang);

  /** @type {AnnotatedLine[]} */
  const lines = [];

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ") || rawLine.startsWith("@@ ")) {
      lines.push({ tokens: createPlainTokens(rawLine, "#8b949e") });
      continue;
    }

    if (rawLine === "\\ No newline at end of file") {
      lines.push({ tokens: createPlainTokens(rawLine, "#d29922") });
      continue;
    }

    if (rawLine.startsWith("+")) {
      lines.push({
        tokens: tokenizeDiffContentLine(hl, rawLine.slice(1), shikiLang),
        bg: DIFF_ADD_BG,
        gutter: DIFF_ADD_GUTTER,
        prefix: "+",
      });
      continue;
    }

    if (rawLine.startsWith("-")) {
      lines.push({
        tokens: tokenizeDiffContentLine(hl, rawLine.slice(1), shikiLang),
        bg: DIFF_DEL_BG,
        gutter: DIFF_DEL_GUTTER,
        prefix: "-",
      });
      continue;
    }

    if (rawLine.startsWith(" ")) {
      lines.push({
        tokens: tokenizeDiffContentLine(hl, rawLine.slice(1), shikiLang),
        prefix: " ",
      });
      continue;
    }

    lines.push({ tokens: createPlainTokens(rawLine) });
  }

  return renderDiffAnnotatedLines(lines);
}

/**
 * @param {Awaited<ReturnType<typeof createHighlighter>>} hl
 * @param {string} line
 * @param {import("shiki").BundledLanguage} language
 * @returns {import("shiki").ThemedToken[]}
 */
function tokenizeDiffContentLine(hl, line, language) {
  const tokenLines = hl.codeToTokens(line, { lang: language, theme: THEME }).tokens;
  return tokenLines[0] ?? createPlainTokens("");
}

/**
 * @param {string} content
 * @param {string} [color]
 * @returns {import("shiki").ThemedToken[]}
 */
function createPlainTokens(content, color = TEXT_COLOR) {
  return [{ content, color, offset: 0 }];
}

/**
 * Wrap annotated lines to keep diff images narrow enough to stay readable in WhatsApp.
 * @param {AnnotatedLine[]} lines
 * @param {number} maxContentChars
 * @returns {AnnotatedLine[]}
 */
function wrapAnnotatedLines(lines, maxContentChars) {
  if (maxContentChars <= 0) {
    return lines;
  }

  /** @type {AnnotatedLine[]} */
  const wrappedLines = [];

  for (const line of lines) {
    const text = line.tokens.map(token => token.content).join("");
    if (text.length <= maxContentChars) {
      wrappedLines.push(line);
      continue;
    }

    for (const range of splitWrapRanges(text, maxContentChars)) {
      wrappedLines.push({
        ...line,
        tokens: sliceTokens(line.tokens, range.start, range.end),
      });
    }
  }

  return wrappedLines;
}

/**
 * @param {string} text
 * @param {number} maxContentChars
 * @returns {Array<{ start: number, end: number }>}
 */
function splitWrapRanges(text, maxContentChars) {
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= maxContentChars) {
      ranges.push({ start, end: text.length });
      break;
    }

    const limit = start + maxContentChars;
    let breakAt = -1;
    for (let index = limit; index > start; index--) {
      if (/\s/.test(text[index - 1] ?? "")) {
        breakAt = index - 1;
        break;
      }
    }

    if (breakAt < start) {
      ranges.push({ start, end: limit });
      start = limit;
      continue;
    }

    let nextStart = breakAt + 1;
    while (nextStart < text.length && /\s/.test(text[nextStart] ?? "")) {
      nextStart += 1;
    }

    if (breakAt === start) {
      ranges.push({ start, end: limit });
      start = limit;
      continue;
    }

    ranges.push({ start, end: breakAt });
    start = nextStart;
  }

  return ranges;
}

/**
 * @param {import("shiki").ThemedToken[]} tokens
 * @param {number} start
 * @param {number} end
 * @returns {import("shiki").ThemedToken[]}
 */
function sliceTokens(tokens, start, end) {
  /** @type {import("shiki").ThemedToken[]} */
  const slicedTokens = [];
  let offset = 0;

  for (const token of tokens) {
    const tokenStart = offset;
    const tokenEnd = tokenStart + token.content.length;
    offset = tokenEnd;

    if (tokenEnd <= start || tokenStart >= end) {
      continue;
    }

    const sliceStart = Math.max(start - tokenStart, 0);
    const sliceEnd = Math.min(end - tokenStart, token.content.length);
    const content = token.content.slice(sliceStart, sliceEnd);
    if (!content) {
      continue;
    }

    slicedTokens.push({
      ...token,
      content,
      offset: slicedTokens.length === 0 ? 0 : slicedTokens[slicedTokens.length - 1].offset + slicedTokens[slicedTokens.length - 1].content.length,
    });
  }

  return slicedTokens.length > 0 ? slicedTokens : createPlainTokens("");
}

/**
 * @param {AnnotatedLine[]} lines
 * @returns {Buffer[]}
 */
function renderDiffAnnotatedLines(lines) {
  const maxContentChars = maxCharsForLayout(lines.length, {
    maxAspectRatio: DIFF_MAX_ASPECT_RATIO,
    gutterWidth: GUTTER_WIDTH,
    prefixChars: 1,
  });
  const wrappedLines = wrapAnnotatedLines(lines, maxContentChars);
  return renderAnnotatedLines(wrappedLines, {
    gutterWidth: GUTTER_WIDTH,
    maxSvgWidth: DIFF_MAX_SVG_WIDTH,
    maxLinesPerChunk: DIFF_MAX_LINES_PER_CHUNK,
  });
}
