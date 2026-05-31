import { createHighlighter } from "shiki";
import { Resvg } from "@resvg/resvg-js";
import { createPatch } from "diff";
import { createLogger } from "./logger.js";

const log = createLogger("code-image-renderer");

export const MIN_LINES_FOR_IMAGE = 5;
const FONT_SIZE = 14;
const LINE_HEIGHT = 20;
const PADDING = 16;
const CHAR_WIDTH = FONT_SIZE * 0.6;
const MIN_WRAP_CHARS = 20;
const CONTINUATION_INDENT = "    ";
const CODE_IMAGE_WIDTH_CAP = 560;
const CHUNK_HEIGHT_OVERFLOW_RATIO = 1.15;

/**
 * Maximum image aspect ratio (width:height) before WhatsApp renders the
 * content too densely. A ratio of ~2:1 keeps code and diff images narrow
 * enough that WhatsApp presents them larger on mobile.
 */
const MAX_ASPECT_RATIO = 2;
const MAX_PIXELS = 12_500_000;
const MAX_SVG_WIDTH = 2000;
const MAX_LINES_PER_CHUNK = 50;
export const DIFF_CONTEXT_LINES = 8;

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

/**
 * Compute the maximum number of content characters that fit within a fixed image width cap.
 * @param {{ maxSvgWidth: number, gutterWidth?: number, prefixChars?: number }} options
 * @returns {number}
 */
function maxContentCharsForWidthCap(options) {
  const gutterWidth = options.gutterWidth ?? 0;
  const prefixChars = options.prefixChars ?? 0;
  const maxChars = Math.floor((options.maxSvgWidth - PADDING * 2 - gutterWidth) / CHAR_WIDTH) - prefixChars;
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
const TABLE_CELL_PADDING_V = 6;
const TABLE_BORDER_COLOR = "#30363d";
const TEXT_COLOR = "#e6edf3";
const CODE_TEXT_COLOR = "#d2a8ff";
const BOLD_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf";
const ITALIC_FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationMono-Italic.ttf";
const BOLD_ITALIC_FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationMono-BoldItalic.ttf";
export const MIN_ROWS_FOR_TABLE_IMAGE = 3;
const TABLE_IMAGE_WIDTH_CAP = 760;
const TABLE_MIN_COL_WIDTH = 64;
const TABLE_MIN_READABLE_COL_WIDTH = 160;
const TABLE_MAX_CHUNK_HEIGHT = 2200;
const TABLE_MAX_PREVIEW_ASPECT_RATIO = 2;

/**
 * @typedef {{
 *   cells: TableTextRun[][][],
 *   height: number,
 * }} TableRowLayout
 */

/**
 * @typedef {{
 *   text: string,
 *   bold?: boolean,
 *   italic?: boolean,
 *   code?: boolean,
 * }} TableTextRun
 */

/**
 * @typedef {{ bold: boolean, italic: boolean, code: boolean }} TableTextStyle
 */

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
 *   maxContentChars: number,
 *   continuationIndent?: string,
 * }} AnnotatedLineWrapOptions
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

  // Width is decided first from the longest wrapped line. From that final width,
  // derive a height cap, then allow a small last-chunk overflow to avoid
  // emitting trailing images with only a few lines.
  const minChunkHeightByLineLimit = maxLinesPerChunkLimit * LINE_HEIGHT + PADDING * 2;
  const maxHeightByAspect = Math.max(LINE_HEIGHT + PADDING * 2, Math.floor(svgWidth * MAX_ASPECT_RATIO));
  const maxHeightByPixels = Math.max(LINE_HEIGHT + PADDING * 2, Math.floor(maxPixels / svgWidth));
  const baseMaxChunkHeight = Math.min(maxHeightByPixels, Math.max(maxHeightByAspect, minChunkHeightByLineLimit));
  const overflowMaxChunkHeight = Math.min(
    Math.floor(baseMaxChunkHeight * CHUNK_HEIGHT_OVERFLOW_RATIO),
    maxHeightByPixels,
  );
  const maxLinesPerChunk = Math.max(1, Math.floor((baseMaxChunkHeight - PADDING * 2) / LINE_HEIGHT));
  const maxLinesPerChunkWithOverflow = Math.max(maxLinesPerChunk, Math.floor((overflowMaxChunkHeight - PADDING * 2) / LINE_HEIGHT));

  /** @type {AnnotatedLine[][]} */
  const chunks = [];
  for (let i = 0; i < lines.length; i += maxLinesPerChunk) {
    const remainingLines = lines.length - i;
    if (remainingLines <= maxLinesPerChunkWithOverflow) {
      chunks.push(lines.slice(i));
      break;
    }
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

  return renderCodeLikeAnnotatedLines(lines);
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
 * @param {string | undefined} char
 * @returns {boolean}
 */
function isWordChar(char) {
  return typeof char === "string" && /[A-Za-z0-9]/.test(char);
}

/**
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @returns {boolean}
 */
function canOpenUnderscoreDelimiter(text, index, length) {
  return !isWordChar(text[index - 1]) && !/\s/.test(text[index + length] ?? "");
}

/**
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @returns {boolean}
 */
function canCloseUnderscoreDelimiter(text, index, length) {
  return !/\s/.test(text[index - 1] ?? "") && !isWordChar(text[index + length]);
}

/**
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @returns {boolean}
 */
function canOpenAsteriskDelimiter(text, index, length) {
  return !/\s/.test(text[index + length] ?? "");
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function canCloseAsteriskDelimiter(text, index) {
  return !/\s/.test(text[index - 1] ?? "");
}

/**
 * @param {TableTextStyle} style
 * @returns {TableTextStyle}
 */
function cloneTableTextStyle(style) {
  return { bold: style.bold, italic: style.italic, code: style.code };
}

/**
 * @param {TableTextRun[]} runs
 * @param {string} text
 * @param {TableTextStyle} style
 * @returns {void}
 */
function pushTableTextRun(runs, text, style) {
  if (!text) return;
  const previous = runs[runs.length - 1];
  if (
    previous
    && Boolean(previous.bold) === style.bold
    && Boolean(previous.italic) === style.italic
    && Boolean(previous.code) === style.code
  ) {
    previous.text += text;
    return;
  }
  runs.push({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.code ? { code: true } : {}),
  });
}

/**
 * @param {string} text
 * @param {string} delimiter
 * @param {number} fromIndex
 * @returns {number}
 */
function findUnescapedDelimiter(text, delimiter, fromIndex) {
  for (let index = fromIndex; index < text.length; index++) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text.startsWith(delimiter, index)) {
      return index;
    }
  }
  return -1;
}

/**
 * @param {string} text
 * @param {string} delimiter
 * @param {number} fromIndex
 * @returns {number}
 */
function findClosingEmphasisDelimiter(text, delimiter, fromIndex) {
  for (let index = fromIndex; index < text.length; index++) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (!text.startsWith(delimiter, index)) {
      continue;
    }
    if (delimiter.startsWith("_") && !canCloseUnderscoreDelimiter(text, index, delimiter.length)) {
      continue;
    }
    if (delimiter.startsWith("*") && !canCloseAsteriskDelimiter(text, index)) {
      continue;
    }
    return index;
  }
  return -1;
}

/**
 * Parse the small inline Markdown subset supported inside rendered table cells.
 * @param {string} text
 * @param {Partial<TableTextStyle>} [baseStyle]
 * @returns {TableTextRun[]}
 */
export function parseTableCellMarkdown(text, baseStyle = {}) {
  /** @type {TableTextRun[]} */
  const runs = [];
  const style = {
    bold: Boolean(baseStyle.bold),
    italic: Boolean(baseStyle.italic),
    code: Boolean(baseStyle.code),
  };
  let buffer = "";
  let index = 0;

  const flush = () => {
    pushTableTextRun(runs, buffer, style);
    buffer = "";
  };

  while (index < text.length) {
    const char = text[index];

    if (char === "\\" && index + 1 < text.length) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      const closeIndex = findUnescapedDelimiter(text, "`", index + 1);
      if (closeIndex !== -1) {
        flush();
        pushTableTextRun(runs, text.slice(index + 1, closeIndex), { ...cloneTableTextStyle(style), code: true });
        index = closeIndex + 1;
        continue;
      }
    }

    /** @type {Array<{ delimiter: string, styleKey: "bold" | "italic" }>} */
    const delimiterCandidates = [
      { delimiter: "**", styleKey: "bold" },
      { delimiter: "__", styleKey: "bold" },
      { delimiter: "*", styleKey: "italic" },
      { delimiter: "_", styleKey: "italic" },
    ];

    let matched = false;
    for (const candidate of delimiterCandidates) {
      const { delimiter, styleKey } = candidate;
      if (!text.startsWith(delimiter, index)) continue;
      if (delimiter.startsWith("_") && !canOpenUnderscoreDelimiter(text, index, delimiter.length)) continue;
      if (delimiter.startsWith("*") && !canOpenAsteriskDelimiter(text, index, delimiter.length)) continue;

      const closeIndex = findClosingEmphasisDelimiter(text, delimiter, index + delimiter.length);
      if (closeIndex === -1) continue;

      flush();
      const nestedStyle = { ...cloneTableTextStyle(style), [styleKey]: true };
      for (const run of parseTableCellMarkdown(text.slice(index + delimiter.length, closeIndex), nestedStyle)) {
        pushTableTextRun(runs, run.text, {
          bold: Boolean(run.bold),
          italic: Boolean(run.italic),
          code: Boolean(run.code),
        });
      }
      index = closeIndex + delimiter.length;
      matched = true;
      break;
    }
    if (matched) continue;

    buffer += char;
    index += 1;
  }

  flush();
  return runs;
}

/**
 * @param {TableTextRun[]} runs
 * @returns {string}
 */
export function tableTextRunsToPlainText(runs) {
  return runs.map(run => run.text).join("");
}

/**
 * @typedef {TableTextStyle & { char: string }} StyledTableChar
 */

/**
 * @param {TableTextRun[]} runs
 * @returns {StyledTableChar[]}
 */
function tableRunsToStyledChars(runs) {
  /** @type {StyledTableChar[]} */
  const chars = [];
  for (const run of runs) {
    for (const char of run.text.replace(/\s+/g, " ")) {
      chars.push({
        char,
        bold: Boolean(run.bold),
        italic: Boolean(run.italic),
        code: Boolean(run.code),
      });
    }
  }
  return chars;
}

/**
 * @param {StyledTableChar[]} chars
 * @returns {TableTextRun[]}
 */
function styledCharsToTableRuns(chars) {
  /** @type {TableTextRun[]} */
  const runs = [];
  for (const item of chars) {
    pushTableTextRun(runs, item.char, item);
  }
  return runs.length ? runs : [{ text: "" }];
}

/**
 * @param {StyledTableChar[]} chars
 * @returns {StyledTableChar[]}
 */
function trimStyledTableChars(chars) {
  let start = 0;
  let end = chars.length;
  while (start < end && chars[start].char === " ") start += 1;
  while (end > start && chars[end - 1].char === " ") end -= 1;
  return chars.slice(start, end);
}

/**
 * @param {StyledTableChar[]} chars
 * @returns {number}
 */
function findLastTableCharBreakIndex(chars) {
  for (let index = chars.length - 1; index >= 0; index--) {
    if (chars[index].char === " ") return index;
  }
  return -1;
}

/**
 * Wrap display text runs into lines that fit a table cell.
 * @param {string} text
 * @param {number} maxChars
 * @returns {TableTextRun[][]}
 */
function wrapTableCellText(text, maxChars) {
  const chars = trimStyledTableChars(tableRunsToStyledChars(parseTableCellMarkdown(text)));
  if (chars.length === 0) return [[{ text: "" }]];

  /** @type {TableTextRun[][]} */
  const lines = [];
  /** @type {StyledTableChar[]} */
  let current = [];
  let lastBreakIndex = -1;

  /**
   * @param {StyledTableChar[]} lineChars
   * @returns {void}
   */
  const pushLine = (lineChars) => {
    lines.push(styledCharsToTableRuns(trimStyledTableChars(lineChars)));
  };

  for (const char of chars) {
    current.push(char);
    if (char.char === " ") {
      lastBreakIndex = current.length - 1;
    }
    if (current.length <= maxChars) {
      continue;
    }

    if (lastBreakIndex > 0) {
      pushLine(current.slice(0, lastBreakIndex));
      current = trimStyledTableChars(current.slice(lastBreakIndex + 1));
      lastBreakIndex = findLastTableCharBreakIndex(current);
      continue;
    }

    pushLine(current.slice(0, maxChars));
    current = trimStyledTableChars(current.slice(maxChars));
    lastBreakIndex = findLastTableCharBreakIndex(current);
  }

  if (current.length > 0) pushLine(current);
  return lines.length ? lines : [[{ text: "" }]];
}

/**
 * Estimate unconstrained table column widths from normalized cell text.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {number[]}
 */
function computeDesiredTableColumnWidths(headers, rows) {
  return headers.map((h, i) => {
    let maxLen = tableTextRunsToPlainText(parseTableCellMarkdown(h)).length;
    for (const row of rows) {
      const cellLength = tableTextRunsToPlainText(parseTableCellMarkdown(row[i] ?? "")).length;
      if (cellLength > maxLen) maxLen = cellLength;
    }
    return Math.max(TABLE_MIN_COL_WIDTH, maxLen * CHAR_WIDTH + TABLE_CELL_PADDING_H * 2);
  });
}

/**
 * Allocate table column widths within a readable image width cap.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {number[]}
 */
function computeTableColumnWidths(headers, rows) {
  const desiredWidths = computeDesiredTableColumnWidths(headers, rows);

  const maxContentWidth = TABLE_IMAGE_WIDTH_CAP - PADDING * 2;
  const desiredTotal = desiredWidths.reduce((a, b) => a + b, 0);
  if (desiredTotal <= maxContentWidth) return desiredWidths;

  const minTotal = TABLE_MIN_COL_WIDTH * headers.length;
  if (minTotal >= maxContentWidth) return desiredWidths.map(() => TABLE_MIN_COL_WIDTH);

  const flexibleTotal = desiredWidths.reduce((total, width) => total + Math.max(0, width - TABLE_MIN_COL_WIDTH), 0);
  const flexibleBudget = maxContentWidth - minTotal;
  return desiredWidths.map(width => {
    const flex = Math.max(0, width - TABLE_MIN_COL_WIDTH);
    return Math.floor(TABLE_MIN_COL_WIDTH + flexibleBudget * (flex / flexibleTotal));
  });
}

/**
 * Split very wide tables into column groups so individual cells remain readable
 * instead of shrinking every column into word-by-word wrapping.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {number[][]}
 */
function splitTableColumnIndexes(headers, rows) {
  const desiredWidths = computeDesiredTableColumnWidths(headers, rows);
  const maxContentWidth = TABLE_IMAGE_WIDTH_CAP - PADDING * 2;
  const desiredTotal = desiredWidths.reduce((a, b) => a + b, 0);
  if (desiredTotal <= maxContentWidth) {
    return [headers.map((_header, index) => index)];
  }

  const maxColumnsPerReadableChunk = Math.max(1, Math.floor(maxContentWidth / TABLE_MIN_READABLE_COL_WIDTH));
  if (headers.length <= maxColumnsPerReadableChunk) {
    return [headers.map((_header, index) => index)];
  }

  /** @type {number[][]} */
  const chunks = [];
  for (let index = 0; index < headers.length; index += maxColumnsPerReadableChunk) {
    chunks.push(headers.slice(index, index + maxColumnsPerReadableChunk).map((_header, offset) => index + offset));
  }
  return chunks;
}

/**
 * @param {string[]} cells
 * @param {number[]} colWidths
 * @returns {TableRowLayout}
 */
function layoutTableRow(cells, colWidths) {
  const wrappedCells = cells.map((cell, col) => {
    const maxChars = Math.max(1, Math.floor((colWidths[col] - TABLE_CELL_PADDING_H * 2) / CHAR_WIDTH));
    return wrapTableCellText(cell ?? "", maxChars);
  });
  const lineCount = Math.max(1, ...wrappedCells.map(lines => lines.length));
  return {
    cells: wrappedCells,
    height: lineCount * LINE_HEIGHT + TABLE_CELL_PADDING_V * 2,
  };
}

/**
 * Render one vertical row-chunked table image set for the given columns.
 * @param {string[]} headers
 * @param {ColumnAlignment[]} alignments
 * @param {string[][]} rows
 * @returns {Buffer[]}
 */
function renderTableColumnGroupToImages(headers, alignments, rows) {
  // ── measure column widths ─────────────────────────────────────────
  const maxPixels = 12_500_000;
  const MAX_LINES_PER_CHUNK = 100;

  const colWidths = computeTableColumnWidths(headers, rows);
  const tableContentWidth = colWidths.reduce((a, b) => a + b, 0);
  const svgWidth = tableContentWidth + PADDING * 2;

  const headerLayout = layoutTableRow(headers, colWidths);
  const rowLayouts = rows.map(row => layoutTableRow(row, colWidths));
  const shortestRowHeight = Math.min(...rowLayouts.map(row => row.height));
  const minimumChunkHeight = PADDING * 2 + headerLayout.height + shortestRowHeight;
  const maxChunkHeight = Math.max(
    minimumChunkHeight,
    Math.min(
      TABLE_MAX_CHUNK_HEIGHT,
      Math.floor(maxPixels / svgWidth),
      Math.floor(svgWidth * TABLE_MAX_PREVIEW_ASPECT_RATIO),
    ),
  );

  // ── chunk rows ────────────────────────────────────────────────────
  /** @type {TableRowLayout[][]} */
  const chunks = [];
  /** @type {TableRowLayout[]} */
  let currentChunk = [];
  let currentHeight = PADDING * 2 + headerLayout.height;
  for (const rowLayout of rowLayouts) {
    const wouldExceedHeight = currentHeight + rowLayout.height > maxChunkHeight;
    const wouldExceedRows = currentChunk.length >= MAX_LINES_PER_CHUNK;
    if (currentChunk.length > 0 && (wouldExceedHeight || wouldExceedRows)) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentHeight = PADDING * 2 + headerLayout.height;
    }
    currentChunk.push(rowLayout);
    currentHeight += rowLayout.height;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  /** @type {Buffer[]} */
  const images = [];

  for (const chunk of chunks) {
    const svgHeight = PADDING * 2 + headerLayout.height + chunk.reduce((total, row) => total + row.height, 0);

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">`;
    svg += `<rect width="100%" height="100%" fill="${BG_COLOR}" rx="8"/>`;

    /**
     * Draw a row of text cells.
     * @param {TableRowLayout} row
     * @param {number} y
     * @param {boolean} isHeader
     */
    const drawRow = (row, y, isHeader) => {
      // Header background
      if (isHeader) {
        svg += `<rect x="${PADDING}" y="${y}" width="${svgWidth - PADDING * 2}" height="${row.height}" fill="${TABLE_HEADER_BG}"/>`;
      }

      let x = PADDING;
      for (let col = 0; col < headers.length; col++) {
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

        const cellLines = row.cells[col] ?? [[{ text: "" }]];
        for (let lineIndex = 0; lineIndex < cellLines.length; lineIndex++) {
          const textY = y + TABLE_CELL_PADDING_V + (lineIndex + 1) * LINE_HEIGHT - 4;
          svg += `<text x="${textX}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${TEXT_COLOR}" text-anchor="${anchor}" xml:space="preserve">`;
          for (const run of cellLines[lineIndex]) {
            const runWeight = isHeader || run.bold ? ` font-weight="bold"` : "";
            const runStyle = run.italic ? ` font-style="italic"` : "";
            const runFill = run.code ? CODE_TEXT_COLOR : TEXT_COLOR;
            svg += `<tspan fill="${runFill}"${runWeight}${runStyle}>${escapeXml(run.text)}</tspan>`;
          }
          svg += `</text>`;
        }

        x += colWidths[col];
      }
    };

    // Draw header
    let y = PADDING;
    drawRow(headerLayout, y, true);

    // Header separator (thicker)
    y += headerLayout.height;
    const sepY = y;
    svg += `<line x1="${PADDING}" y1="${sepY}" x2="${svgWidth - PADDING}" y2="${sepY}" stroke="${TABLE_BORDER_COLOR}" stroke-width="2"/>`;

    // Draw data rows
    for (let r = 0; r < chunk.length; r++) {
      const row = chunk[r];
      drawRow(row, y, false);
      y += row.height;

      // Row separator
      if (r < chunk.length - 1) {
        svg += `<line x1="${PADDING}" y1="${y}" x2="${svgWidth - PADDING}" y2="${y}" stroke="${TABLE_BORDER_COLOR}" stroke-width="1"/>`;
      }
    }

    // Vertical column separators
    let vx = PADDING;
    for (let col = 0; col < headers.length - 1; col++) {
      vx += colWidths[col];
      svg += `<line x1="${vx}" y1="${PADDING}" x2="${vx}" y2="${svgHeight - PADDING}" stroke="${TABLE_BORDER_COLOR}" stroke-width="1"/>`;
    }

    svg += `</svg>`;

    const resvg = new Resvg(svg, {
      font: {
        fontFiles: [FONT_PATH, BOLD_FONT_PATH, ITALIC_FONT_PATH, BOLD_ITALIC_FONT_PATH],
        loadSystemFonts: false,
      },
    });
    const pngData = resvg.render();
    images.push(Buffer.from(pngData.asPng()));
  }

  return images;
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

  /** @type {Buffer[]} */
  const images = [];
  for (const columnIndexes of splitTableColumnIndexes(headers, rows)) {
    const columnHeaders = columnIndexes.map(index => headers[index] ?? "");
    const columnAlignments = columnIndexes.map(index => alignments[index] ?? "left");
    const columnRows = rows.map(row => columnIndexes.map(index => row[index] ?? ""));
    images.push(...renderTableColumnGroupToImages(columnHeaders, columnAlignments, columnRows));
  }
  return images;
}

/**
 * @param {string} oldStr
 * @param {string} newStr
 * @param {number} [contextLines]
 * @returns {string}
 */
export function buildContextualUnifiedDiff(oldStr, newStr, contextLines = DIFF_CONTEXT_LINES) {
  const normalizedContext = Number.isInteger(contextLines) && contextLines >= 0
    ? contextLines
    : DIFF_CONTEXT_LINES;
  const patch = createPatch("change", oldStr, newStr, "", "", { context: normalizedContext });
  const lines = patch.split("\n");
  const filtered = lines.filter((line) => !(
    line.startsWith("Index: ")
    || line.startsWith("===")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
  ));
  return filtered.join("\n").trimEnd();
}

/**
 * Render a diff (old_string → new_string) as syntax-highlighted PNG image(s).
 * Removed lines show with red background, added lines with green background,
 * each with a +/- gutter prefix. Context is bounded to keep large file edits
 * readable in chat.
 * @param {string} oldStr
 * @param {string} newStr
 * @param {string} [language]
 * @returns {Promise<Buffer[]>}
 */
export async function renderDiffToImages(oldStr, newStr, language) {
  const diffText = buildContextualUnifiedDiff(oldStr, newStr);
  if (!diffText) {
    return [];
  }
  return renderUnifiedDiffToImages(diffText, language);
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

  return renderCodeLikeAnnotatedLines(lines, { gutterWidth: GUTTER_WIDTH, prefixChars: 1 });
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
 * Wrap annotated lines to keep code and diff images readable in WhatsApp.
 * @param {AnnotatedLine[]} lines
 * @param {AnnotatedLineWrapOptions} options
 * @returns {AnnotatedLine[]}
 */
export function wrapAnnotatedLinesForDisplay(lines, options) {
  const maxContentChars = options.maxContentChars;
  if (maxContentChars <= 0) {
    return lines;
  }

  const continuationIndent = options.continuationIndent ?? CONTINUATION_INDENT;
  const continuationContentChars = Math.max(maxContentChars - continuationIndent.length, 1);

  /** @type {AnnotatedLine[]} */
  const wrappedLines = [];

  for (const line of lines) {
    const text = line.tokens.map(token => token.content).join("");
    if (text.length <= maxContentChars) {
      wrappedLines.push(line);
      continue;
    }

    const ranges = splitWrapRanges(text, maxContentChars, continuationContentChars);
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      const tokens = sliceTokens(line.tokens, range.start, range.end);
      wrappedLines.push({
        ...line,
        tokens: index === 0 ? tokens : prefixTokens(tokens, continuationIndent),
      });
    }
  }

  return wrappedLines;
}

/**
 * @param {string} text
 * @param {number} firstLineChars
 * @param {number} continuationChars
 * @returns {Array<{ start: number, end: number }>}
 */
function splitWrapRanges(text, firstLineChars, continuationChars) {
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = [];
  let start = 0;
  let currentLineChars = firstLineChars;

  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= currentLineChars) {
      ranges.push({ start, end: text.length });
      break;
    }

    const limit = start + currentLineChars;
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
      currentLineChars = continuationChars;
      continue;
    }

    let nextStart = breakAt + 1;
    while (nextStart < text.length && /\s/.test(text[nextStart] ?? "")) {
      nextStart += 1;
    }

    if (breakAt === start) {
      ranges.push({ start, end: limit });
      start = limit;
      currentLineChars = continuationChars;
      continue;
    }

    ranges.push({ start, end: breakAt });
    start = nextStart;
    currentLineChars = continuationChars;
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
 * @param {import("shiki").ThemedToken[]} tokens
 * @param {string} prefix
 * @returns {import("shiki").ThemedToken[]}
 */
function prefixTokens(tokens, prefix) {
  if (!prefix) {
    return tokens;
  }

  /** @type {import("shiki").ThemedToken[]} */
  const prefixedTokens = createPlainTokens(prefix);
  let offset = prefix.length;

  for (const token of tokens) {
    prefixedTokens.push({
      ...token,
      offset,
    });
    offset += token.content.length;
  }

  return prefixedTokens;
}

/**
 * @param {AnnotatedLine[]} lines
 * @param {{ gutterWidth?: number, prefixChars?: number }} [options]
 * @returns {Buffer[]}
 */
function renderCodeLikeAnnotatedLines(lines, options) {
  const gutterWidth = options?.gutterWidth ?? 0;
  const prefixChars = options?.prefixChars ?? 0;
  const maxContentChars = maxContentCharsForWidthCap({
    maxSvgWidth: CODE_IMAGE_WIDTH_CAP,
    gutterWidth,
    prefixChars,
  });
  const wrappedLines = wrapAnnotatedLinesForDisplay(lines, {
    maxContentChars,
    continuationIndent: CONTINUATION_INDENT,
  });
  return renderAnnotatedLines(wrappedLines, {
    gutterWidth,
    maxSvgWidth: CODE_IMAGE_WIDTH_CAP,
    maxLinesPerChunk: MAX_LINES_PER_CHUNK,
  });
}
