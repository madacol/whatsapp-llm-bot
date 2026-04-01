/**
 * Message rendering pipeline — converts ToolContentBlocks into
 * transport-agnostic SendInstructions for the WhatsApp adapter to send.
 *
 * Pure rendering logic: markdown conversion, code image rendering,
 * diff image rendering. No Baileys/socket dependency.
 */

import { basename } from "node:path";
import { renderCodeToImages, renderDiffToImages, renderTableToImages, renderUnifiedDiffToImages, MIN_LINES_FOR_IMAGE, MIN_ROWS_FOR_TABLE_IMAGE } from "./code-image-renderer.js";
import { createLogger } from "./logger.js";
import { splitEmbeddedMarkdownImages } from "./markdown-embedded-images.js";
import { readBlockBuffer } from "./media-store.js";

const log = createLogger("message-renderer");

/**
 * A single WhatsApp message to be sent, produced by the rendering pipeline.
 * `editable` flags messages whose key should be tracked for in-place editing.
 * @typedef {
 *   | { kind: "text", text: string, editable: boolean }
 *   | { kind: "image", image: Buffer, caption?: string, editable: boolean, hd?: boolean }
 *   | { kind: "video", video: Buffer, mimetype: string, caption?: string }
 *   | { kind: "audio", audio: Buffer, mimetype: string }
 * } SendInstruction
 */

/**
 * Languages that should be rendered as syntax-highlighted images.
 * Code blocks without a language or with non-programming identifiers
 * (e.g. "text", "log", "output", "plaintext") are sent as formatted text.
 */
export const CODE_IMAGE_LANGUAGES = new Set([
  // Systems / compiled
  "c", "cpp", "csharp", "go", "rust", "java", "kotlin", "swift", "scala",
  "dart", "zig", "nim", "d", "haskell", "ocaml", "fsharp", "elixir", "erlang",
  "clojure", "fortran", "pascal", "ada", "assembly", "asm", "wasm",
  // Web / scripting
  "javascript", "js", "typescript", "ts", "jsx", "tsx", "python", "py",
  "ruby", "rb", "php", "perl", "lua", "r", "julia", "groovy",
  // Shell
  "bash", "sh", "zsh", "fish", "powershell", "ps1", "bat", "cmd",
  // Markup / config that benefits from highlighting
  "html", "css", "scss", "sass", "less", "xml", "svg",
  "json", "yaml", "yml", "toml", "ini", "graphql", "sql",
  // Other
  "dockerfile", "makefile", "cmake", "nginx", "terraform", "hcl",
  "proto", "protobuf", "latex", "tex", "matlab", "objectivec", "objc",
  "vue", "svelte", "astro", "mdx",
]);

/**
 * Check whether a code block should be rendered as a syntax-highlighted image
 * (true) or sent as plain formatted text (false).
 * Requires a recognized programming language and at least MIN_LINES_FOR_IMAGE lines.
 * @param {string} lang
 * @param {string} code
 * @returns {boolean}
 */
export function shouldRenderAsImage(lang, code) {
  if (!CODE_IMAGE_LANGUAGES.has(lang.toLowerCase())) return false;
  const lineCount = code.split("\n").length;
  return lineCount >= MIN_LINES_FOR_IMAGE;
}

/**
 * Convert standard Markdown to WhatsApp-compatible formatting.
 * WhatsApp uses: *bold*, _italic_, ~strikethrough~, ```code```, > quote
 * @param {string} text
 * @returns {string}
 */
export function markdownToWhatsApp(text) {
  let result = text;

  // Italic first: *text* (single asterisk) → _text_
  // Must run BEFORE bold conversion so **bold** doesn't get re-matched as italic
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Headers: # Heading → *Heading* (bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Images: ![alt](url) → alt (url) — must be before links
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)");

  // Links: [text](url) → text (url), except local file refs which should
  // degrade to a compact label for WhatsApp. File refs may also include an
  // explicit trailing :line suffix outside the markdown link.
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)(?::(\d+)(?::(\d+))?)?/g,
    (_match, label, target, explicitLine, explicitColumn) => formatMarkdownLink(label, target, explicitLine, explicitColumn),
  );

  // Unordered lists: - item or * item → • item (preserve indentation)
  // Use non-breaking spaces (\u00A0) because WhatsApp strips regular leading spaces
  result = result.replace(/^([\t ]*)[-*]\s+/gm, (_match, indent) => {
    const depth = indent ? Math.floor(indent.replace(/\t/g, "  ").length / 2) : 0;
    return "\u00A0\u00A0".repeat(depth) + "• ";
  });

  // Ordered lists: 1. item → 1. item (preserve indentation)
  result = result.replace(/^([\t ]*)(\d+)\.\s+/gm, (_match, indent, num) => {
    const depth = indent ? Math.floor(indent.replace(/\t/g, "  ").length / 2) : 0;
    return "\u00A0\u00A0".repeat(depth) + num + ". ";
  });

  // Horizontal rules: --- or *** or ___ → ———
  result = result.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, "———");

  return result;
}

/**
 * Prefix a rendered text fragment when the message source has a visible marker.
 * @param {string} prefix
 * @param {string} text
 * @returns {string}
 */
function prependSourcePrefix(prefix, text) {
  return prefix ? `${prefix} ${text}` : text;
}

/**
 * Render a markdown link into compact WhatsApp text.
 * @param {string} label
 * @param {string} target
 * @param {string | undefined} explicitLine
 * @param {string | undefined} explicitColumn
 * @returns {string}
 */
function formatMarkdownLink(label, target, explicitLine, explicitColumn) {
  if (!isLocalFileTarget(target)) {
    return `${label} (${target})${formatExplicitLocationSuffix(explicitLine, explicitColumn)}`;
  }

  const normalizedLabel = stripInlineCodeFence(label);
  const lineNumber = explicitLine ?? getLocalFileLineNumber(target);
  if (!lineNumber || labelIncludesLineNumber(normalizedLabel, lineNumber)) {
    return formatInlineCode(normalizedLabel);
  }

  return formatInlineCode(`${normalizedLabel}:${lineNumber}`);
}

/**
 * @param {string | undefined} explicitLine
 * @param {string | undefined} explicitColumn
 * @returns {string}
 */
function formatExplicitLocationSuffix(explicitLine, explicitColumn) {
  if (!explicitLine) {
    return "";
  }

  return explicitColumn
    ? `:${explicitLine}:${explicitColumn}`
    : `:${explicitLine}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatInlineCode(text) {
  return `\`${text}\``;
}

/**
 * Unwrap a markdown inline-code label so local file refs can be normalized
 * before line metadata is appended and the compact WhatsApp code style is
 * reapplied exactly once.
 * @param {string} text
 * @returns {string}
 */
function stripInlineCodeFence(text) {
  const inlineCodeMatch = text.match(/^(`+)([\s\S]*)\1$/);
  if (!inlineCodeMatch) {
    return text;
  }

  return inlineCodeMatch[2];
}

/**
 * Detect absolute local file targets produced by terminal-style file refs.
 * @param {string} target
 * @returns {boolean}
 */
function isLocalFileTarget(target) {
  if (!target.startsWith("/") || target.startsWith("//")) {
    return false;
  }

  const pathWithoutLocation = stripLocalFileLocation(target);
  return basename(pathWithoutLocation).includes(".");
}

/**
 * Strip trailing line metadata from a local file target.
 * @param {string} target
 * @returns {string}
 */
function stripLocalFileLocation(target) {
  return target
    .replace(/#L\d+(?:C\d+)?$/, "")
    .replace(/:\d+(?::\d+)?$/, "");
}

/**
 * Extract the trailing line number from a local file target.
 * @param {string} target
 * @returns {string | null}
 */
function getLocalFileLineNumber(target) {
  const hashMatch = target.match(/#L(\d+)(?:C\d+)?$/);
  if (hashMatch) {
    return hashMatch[1];
  }

  const colonMatch = target.match(/:(\d+)(?::\d+)?$/);
  if (colonMatch) {
    return colonMatch[1];
  }

  return null;
}

/**
 * @param {string} label
 * @param {string} lineNumber
 * @returns {boolean}
 */
function labelIncludesLineNumber(label, lineNumber) {
  return new RegExp(`(?::|#L)${lineNumber}(?:[:C]\\d+)?$`).test(label);
}

/**
 * Render ToolContentBlocks into transport-agnostic SendInstructions.
 * @param {ToolContentBlock[]} blocks
 * @param {string} prefix - source emoji prefix (e.g. "🤖")
 * @returns {Promise<SendInstruction[]>}
 */
export async function renderBlocks(blocks, prefix) {
  /** @type {SendInstruction[]} */
  const instructions = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        instructions.push({ kind: "text", text: prependSourcePrefix(prefix, block.text), editable: true });
        break;

      case "markdown":
        await renderMarkdownBlock(block.text, prefix, instructions);
        break;

      case "code":
        await renderCodeBlock(block, prefix, instructions);
        break;

      case "diff":
        await renderDiffBlock(/** @type {DiffContentBlock} */ (block), prefix, instructions);
        break;

      case "image":
        instructions.push({
          kind: "image",
          image: await readBlockBuffer(block),
          ...(block.alt && { caption: block.alt }),
          ...(block.quality === "hd" && { hd: true }),
          editable: false,
        });
        break;

      case "video":
        instructions.push({
          kind: "video",
          video: await readBlockBuffer(block),
          mimetype: block.mime_type || "video/mp4",
          ...(block.alt && { caption: block.alt }),
        });
        break;

      case "audio":
        instructions.push({
          kind: "audio",
          audio: await readBlockBuffer(block),
          mimetype: block.mime_type || "audio/mp4",
        });
        break;
    }
  }

  return instructions;
}

/** Regex matching the separator row of a markdown table. */
const TABLE_SEP_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/**
 * Split a text segment into interleaved text and table segments.
 * A markdown table is: header row → separator row → 1+ data rows,
 * where every line contains at least one `|`.
 * @param {string} text
 * @returns {Array<{ kind: "text" | "table", text: string }>}
 */
export function splitTables(text) {
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

  let i = 0;
  while (i < lines.length) {
    // Check for table start: line with |, followed by separator line
    if (
      i + 2 < lines.length &&
      lines[i].includes("|") &&
      TABLE_SEP_RE.test(lines[i + 1])
    ) {
      // Collect table lines
      /** @type {string[]} */
      const tableLines = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && !TABLE_SEP_RE.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }

      const dataRowCount = tableLines.length - 2; // minus header and separator
      if (dataRowCount >= MIN_ROWS_FOR_TABLE_IMAGE) {
        flushTextLines();
        segments.push({ kind: "table", text: tableLines.join("\n") });
      } else {
        // Too small for image — keep as text
        textLines.push(...tableLines);
      }
      i = j;
    } else {
      textLines.push(lines[i]);
      i++;
    }
  }
  flushTextLines();

  return segments;
}

/**
 * Render a markdown block: split into text segments, fenced code blocks,
 * and tables. Render eligible code and tables as images, convert markdown
 * formatting for WhatsApp.
 * @param {string} text
 * @param {string} prefix
 * @param {SendInstruction[]} instructions - mutated, appended to
 */
async function renderMarkdownBlock(text, prefix, instructions) {
  // Split into text segments and fenced code blocks (not inline code).
  // Requires newline after opening ``` to distinguish from inline triple backticks.
  const parts = text.split(/(```\w*\n[\s\S]*?```)/g);

  // Accumulate text segments and non-image code blocks into a single message.
  // Flush the buffer whenever we hit an image-rendered code block or table.
  let textBuffer = "";

  const flushText = () => {
    const trimmed = textBuffer.trim();
    if (trimmed) {
      instructions.push({ kind: "text", text: prependSourcePrefix(prefix, trimmed), editable: true });
    }
    textBuffer = "";
  };

  for (const part of parts) {
    const codeMatch = part.match(/^```(\w*)\n([\s\S]*?)```$/);
    if (codeMatch) {
      const lang = codeMatch[1] || "";
      const code = codeMatch[2].trimEnd();
      if (lang && shouldRenderAsImage(lang, code)) {
        flushText();
        try {
          const images = await renderCodeToImages(code, lang);
          for (const image of images) {
            instructions.push({
              kind: "image",
              image,
              ...(lang && { caption: lang }),
              editable: false,
            });
          }
        } catch (err) {
          log.error("Markdown code image rendering failed, falling back to text:", err);
          textBuffer += "\n```\n" + code + "\n```\n";
        }
      } else {
        textBuffer += "\n```\n" + code + "\n```\n";
      }
    } else {
      // Process text segment: split out tables, render remaining as WhatsApp text
      const tableSegments = splitTables(part);
      for (const seg of tableSegments) {
        if (seg.kind === "table") {
          flushText();
          try {
            const images = renderTableToImages(seg.text);
            for (const image of images) {
              instructions.push({ kind: "image", image, editable: false });
            }
          } catch (err) {
            log.error("Table image rendering failed, falling back to text:", err);
            textBuffer += "\n" + seg.text + "\n";
          }
        } else {
          const inlineSegments = await splitEmbeddedMarkdownImages(seg.text);
          for (const inlineSegment of inlineSegments) {
            if (inlineSegment.kind === "image") {
              flushText();
              instructions.push({
                kind: "image",
                image: inlineSegment.image,
                ...(inlineSegment.caption ? { caption: inlineSegment.caption } : {}),
                editable: false,
              });
              continue;
            }

            const converted = markdownToWhatsApp(inlineSegment.text).trim();
            if (converted) {
              textBuffer += (textBuffer ? "\n" : "") + converted;
            }
          }
        }
      }
    }
  }
  flushText();
}

/**
 * Render a code block: as syntax-highlighted image or plain text.
 * @param {CodeContentBlock} block
 * @param {string} prefix
 * @param {SendInstruction[]} instructions - mutated, appended to
 */
async function renderCodeBlock(block, prefix, instructions) {
  if (block.language && (block.caption || shouldRenderAsImage(block.language, block.code))) {
    try {
      const images = await renderCodeToImages(block.code, block.language);
      for (let i = 0; i < images.length; i++) {
        // Only caption the first image — captionless consecutive images
        // are auto-grouped as an album by WhatsApp.
        instructions.push({
          kind: "image",
          image: images[i],
          ...(i === 0 && block.caption && { caption: prependSourcePrefix(prefix, block.caption) }),
          editable: i === 0,
        });
      }
    } catch (err) {
      log.error("Code image rendering failed, falling back to text:", err);
      instructions.push({
        kind: "text",
        text: "```\n" + block.code + "\n```",
        editable: false,
      });
    }
  } else {
    const caption = block.language ? `_${block.language}_\n` : "";
    instructions.push({
      kind: "text",
      text: caption + "```\n" + block.code + "\n```",
      editable: false,
    });
  }
}

/**
 * Render a diff block as diff images with text fallback.
 * @param {DiffContentBlock} block
 * @param {string} prefix
 * @param {SendInstruction[]} instructions - mutated, appended to
 */
async function renderDiffBlock(block, prefix, instructions) {
  try {
    const images = block.diffText
      ? await renderUnifiedDiffToImages(block.diffText, block.language)
      : await renderDiffToImages(block.oldStr, block.newStr, block.language);
    for (let i = 0; i < images.length; i++) {
      // Only caption the first image — captionless consecutive images
      // are auto-grouped as an album by WhatsApp.
      instructions.push({
        kind: "image",
        image: images[i],
        ...(i === 0 && block.caption && { caption: prependSourcePrefix(prefix, block.caption) }),
        editable: i === 0,
      });
    }
  } catch (err) {
    log.error("Diff image rendering failed, falling back to text:", err);
    const text = block.diffText
      ? "```diff\n" + block.diffText + "\n```"
      : "```\n" + buildSimpleDiffFallback(block.oldStr, block.newStr) + "\n```";
    instructions.push({
      kind: "text",
      text,
      editable: false,
    });
  }
}

/**
 * @param {string} oldStr
 * @param {string} newStr
 * @returns {string}
 */
function buildSimpleDiffFallback(oldStr, newStr) {
  const lines = [];
  for (const line of oldStr.split("\n")) lines.push(`- ${line}`);
  for (const line of newStr.split("\n")) lines.push(`+ ${line}`);
  return lines.join("\n");
}
