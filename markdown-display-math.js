import { createLogger } from "./logger.js";
import { renderDisplayMathToImage } from "./math-image-renderer.js";

const log = createLogger("markdown-display-math");

/**
 * @typedef {
 *   | { kind: "text", text: string }
 *   | { kind: "image", image: Buffer }
 * } MarkdownDisplayMathSegment
 */

/**
 * @param {string} line
 * @returns {boolean}
 */
function isDisplayMathFenceStart(line) {
  const trimmed = line.trim();
  return trimmed === "$$" || trimmed === "\\[";
}

/**
 * @param {string} line
 * @param {"$$" | "\\["} openingFence
 * @returns {boolean}
 */
function isDisplayMathFenceEnd(line, openingFence) {
  const trimmed = line.trim();
  return openingFence === "$$" ? trimmed === "$$" : trimmed === "\\]";
}

/**
 * @param {string} line
 * @returns {{ tex: string, length: number } | null}
 */
function parseSingleLineDisplayMath(line) {
  const trimmed = line.trim();

  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length > 4) {
    return {
      tex: trimmed.slice(2, -2).trim(),
      length: 1,
    };
  }

  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]") && trimmed.length > 4) {
    return {
      tex: trimmed.slice(2, -2).trim(),
      length: 1,
    };
  }

  return null;
}

/**
 * Split a markdown text run into plain text and rendered display-math images.
 * Only block-style `$$...$$` and `\[...\]` math is supported to avoid false
 * positives with currency and ordinary prose.
 * @param {string} text
 * @returns {Promise<MarkdownDisplayMathSegment[]>}
 */
export async function splitDisplayMathBlocks(text) {
  const lines = text.split("\n");
  /** @type {MarkdownDisplayMathSegment[]} */
  const segments = [];
  /** @type {string[]} */
  let textLines = [];

  const flushText = () => {
    if (textLines.length > 0) {
      segments.push({ kind: "text", text: textLines.join("\n") });
      textLines = [];
    }
  };

  let index = 0;
  while (index < lines.length) {
    const singleLineMath = parseSingleLineDisplayMath(lines[index]);
    if (singleLineMath) {
      flushText();
      try {
        segments.push({
          kind: "image",
          image: await renderDisplayMathToImage(singleLineMath.tex),
        });
      } catch (error) {
        log.error("Display math rendering failed, falling back to text:", error);
        textLines.push(lines[index]);
      }
      index += singleLineMath.length;
      continue;
    }

    if (!isDisplayMathFenceStart(lines[index])) {
      textLines.push(lines[index]);
      index += 1;
      continue;
    }

    const openingFence = /** @type {"$$" | "\\["} */ (lines[index].trim());
    const mathLines = [];
    let closingIndex = index + 1;

    while (closingIndex < lines.length && !isDisplayMathFenceEnd(lines[closingIndex], openingFence)) {
      mathLines.push(lines[closingIndex]);
      closingIndex += 1;
    }

    if (closingIndex >= lines.length) {
      textLines.push(lines[index]);
      textLines.push(...mathLines);
      break;
    }

    flushText();

    try {
      segments.push({
        kind: "image",
        image: await renderDisplayMathToImage(mathLines.join("\n").trim()),
      });
    } catch (error) {
      log.error("Display math rendering failed, falling back to text:", error);
      textLines.push(lines[index]);
      textLines.push(...mathLines);
      textLines.push(lines[closingIndex]);
    }

    index = closingIndex + 1;
  }

  flushText();
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}
