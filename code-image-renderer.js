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

/**
 * Maximum image aspect ratio (width:height) before WhatsApp crops or
 * renders the image too small. A ratio of ~6:1 keeps code images readable
 * on mobile without being excessively wide.
 *
 * At 6:1: 1 line → 33 chars, 2 → 47, 3 → 61, 5+ → 80 (capped by caller).
 */
const MAX_ASPECT_RATIO = 6;

/**
 * Compute the maximum number of characters per line that keeps the rendered
 * code image within the target aspect ratio for the given number of lines.
 * Returns Infinity when the line count is high enough that no wrapping is needed.
 * @param {number} lineCount
 * @returns {number}
 */
export function maxCharsForLineCount(lineCount) {
  const height = lineCount * LINE_HEIGHT + PADDING * 2;
  const maxWidth = MAX_ASPECT_RATIO * height;
  // svgWidth = chars * CHAR_WIDTH + PADDING + PADDING  (contentX = PADDING for non-diff)
  const maxChars = Math.floor((maxWidth - PADDING * 2) / CHAR_WIDTH);
  return Math.max(maxChars, 20); // floor at 20 to avoid absurdly narrow wrapping
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
 * Render annotated token lines into PNG image buffers.
 * Each line can have an optional background color, gutter color, and prefix character.
 * @param {AnnotatedLine[]} lines
 * @param {{ gutterWidth?: number }} [opts]
 * @returns {Buffer[]}
 */
function renderAnnotatedLines(lines, opts) {
  const gutterWidth = opts?.gutterWidth ?? 0;
  const contentX = PADDING + gutterWidth;

  // Guard: max pixel budget to prevent OOM from Resvg rendering.
  // Resvg allocates width × height × 4 bytes for the pixel buffer.
  // Cap at ~50MB per image (50_000_000 / 4 = 12_500_000 pixels).
  const MAX_PIXELS = 12_500_000;
  const MAX_SVG_WIDTH = 4000; // ~475 chars at 8.4px/char — generous but bounded

  // Compute image width from the widest line across ALL lines so chunks
  // share a consistent width and we can derive an adaptive chunk size.
  let maxLineWidth = 0;
  for (const line of lines) {
    const lineText = (line.prefix || "") + line.tokens.map(t => t.content).join("");
    const width = estimateTextWidth(lineText);
    if (width > maxLineWidth) maxLineWidth = width;
  }
  const svgWidth = Math.min(Math.max(maxLineWidth + contentX + PADDING, 200), MAX_SVG_WIDTH);

  // Adaptive chunk size: fit as many lines as the pixel budget allows,
  // but cap at 100 lines for readability on mobile screens.
  const MAX_LINES_PER_CHUNK = 100;
  const maxLinesPerChunk = Math.min(
    MAX_LINES_PER_CHUNK,
    Math.max(10, Math.floor((MAX_PIXELS / svgWidth - PADDING * 2) / LINE_HEIGHT)),
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

  return renderAnnotatedLines(lines, { gutterWidth: GUTTER_WIDTH });
}
