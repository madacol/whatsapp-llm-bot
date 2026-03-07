import { createHighlighter } from "shiki";
import { Resvg } from "@resvg/resvg-js";

const MAX_LINES_PER_IMAGE = 45;
const FONT_SIZE = 14;
const LINE_HEIGHT = 20;
const PADDING = 16;
const FONT_FAMILY = "DejaVu Sans Mono";
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
const THEME = "github-dark";
const BG_COLOR = "#0d1117";

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
 * Render code as syntax-highlighted PNG image(s).
 * Splits long code across multiple images at MAX_LINES_PER_IMAGE.
 * @param {string} code
 * @param {string} [language]
 * @returns {Promise<Buffer[]>}
 */
export async function renderCodeToImages(code, language) {
  const hl = await getHighlighter();

  // Load language if needed
  const lang = language || "text";
  const loadedLangs = hl.getLoadedLanguages();
  if (!loadedLangs.includes(lang)) {
    try {
      await hl.loadLanguage(/** @type {import("shiki").BundledLanguage} */ (lang));
    } catch {
      // Fall back to plain text if language not supported
    }
  }

  const effectiveLang = hl.getLoadedLanguages().includes(lang) ? lang : "text";

  const result = hl.codeToTokens(code, { lang: /** @type {import("shiki").BundledLanguage} */ (effectiveLang), theme: THEME });
  const tokenLines = result.tokens;

  // Split into chunks
  /** @type {(typeof tokenLines)[]} */
  const chunks = [];
  for (let i = 0; i < tokenLines.length; i += MAX_LINES_PER_IMAGE) {
    chunks.push(tokenLines.slice(i, i + MAX_LINES_PER_IMAGE));
  }

  /** @type {Buffer[]} */
  const images = [];

  for (const chunk of chunks) {
    // Calculate dimensions
    let maxLineWidth = 0;
    for (const line of chunk) {
      const lineText = line.map(t => t.content).join("");
      const width = estimateTextWidth(lineText);
      if (width > maxLineWidth) maxLineWidth = width;
    }

    const svgWidth = Math.max(maxLineWidth + PADDING * 2, 200);
    const svgHeight = chunk.length * LINE_HEIGHT + PADDING * 2;

    // Build SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">`;
    svg += `<rect width="100%" height="100%" fill="${BG_COLOR}" rx="8"/>`;

    for (let lineIdx = 0; lineIdx < chunk.length; lineIdx++) {
      const y = PADDING + (lineIdx + 1) * LINE_HEIGHT - 4;
      svg += `<text x="${PADDING}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="#e6edf3">`;

      for (const token of chunk[lineIdx]) {
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
