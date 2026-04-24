/**
 * Message rendering pipeline — converts ToolContentBlocks into
 * transport-agnostic SendInstructions for the WhatsApp adapter to send.
 *
 * Pure rendering logic: markdown conversion, code image rendering,
 * diff image rendering. No Baileys/socket dependency.
 */

import { basename } from "node:path";
import { hasMediaPath } from "./attachment-paths.js";
import { renderCodeToImages, renderDiffToImages, renderTableToImages, renderUnifiedDiffToImages, MIN_LINES_FOR_IMAGE } from "./code-image-renderer.js";
import { createLogger } from "./logger.js";
import { renderDisplayMathToImage } from "./math-image-renderer.js";
import { segmentMarkdown } from "./markdown-segments.js";
import { readBlockBuffer } from "./media-store.js";
import { resolvePathToContentBlock } from "./outbound/path-to-content-block.js";
import { formatPlanStatusSymbol, normalizePlanStatusMarker } from "./plan-status-formatting.js";

const log = createLogger("message-renderer");

/**
 * @typedef {{
 *   sourcePath?: string,
 *   mediaPath?: string,
 *   mimeType?: string,
 *   fileName?: string,
 * }} AttachmentDebugInfo
 */

/**
 * A single WhatsApp message to be sent, produced by the rendering pipeline.
 * `editable` flags messages whose key should be tracked for in-place editing.
 * @typedef {
 *   | { kind: "text", text: string, editable: boolean }
 *   | { kind: "image", image: Buffer, caption?: string, editable: boolean, hd?: boolean, debug?: AttachmentDebugInfo }
 *   | { kind: "video", video: Buffer, mimetype: string, caption?: string, debug?: AttachmentDebugInfo }
 *   | { kind: "audio", audio: Buffer, mimetype: string, debug?: AttachmentDebugInfo }
 *   | { kind: "file", file: Buffer, mimetype: string, fileName: string, caption?: string, debug?: AttachmentDebugInfo }
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
 * @param {unknown} error
 * @returns {string}
 */
function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @param {{ sourcePath?: string }} [options]
 * @returns {AttachmentDebugInfo | undefined}
 */
function buildAttachmentDebugInfo(block, options = {}) {
  const debugInfo = {
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    ...(hasMediaPath(block) ? { mediaPath: block.path } : {}),
    ...(block.mime_type ? { mimeType: block.mime_type } : {}),
    ...("file_name" in block && typeof block.file_name === "string" ? { fileName: block.file_name } : {}),
  };

  return Object.keys(debugInfo).length > 0 ? debugInfo : undefined;
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

  // Task list markers at line start, with or without a markdown bullet prefix.
  // Convert them before generic list handling so plan/task checklists become
  // compact status lines in WhatsApp.
  result = result.replace(
    /^([\t ]*)(?:[-*]\s+)?\[([ xX~])\]\s+(.+)$/gm,
    (_match, indent, marker, itemText) => formatWhatsAppTaskItem(indent, marker, itemText),
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
 * @param {string} indent
 * @returns {string}
 */
function formatWhatsAppIndent(indent) {
  const depth = indent ? Math.floor(indent.replace(/\t/g, "  ").length / 2) : 0;
  return "\u00A0\u00A0".repeat(depth);
}

/**
 * @param {string} marker
 * @returns {string}
 */
function formatWhatsAppTaskMarker(marker) {
  return formatPlanStatusSymbol(normalizePlanStatusMarker(marker));
}

/**
 * @param {string} indent
 * @param {string} marker
 * @param {string} itemText
 * @returns {string}
 */
function formatWhatsAppTaskItem(indent, marker, itemText) {
  return `${formatWhatsAppIndent(indent)}${formatWhatsAppTaskMarker(marker)} ${itemText}`;
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
          ...(buildAttachmentDebugInfo(block) ? { debug: buildAttachmentDebugInfo(block) } : {}),
          editable: false,
        });
        break;

      case "video":
        instructions.push({
          kind: "video",
          video: await readBlockBuffer(block),
          mimetype: block.mime_type || "video/mp4",
          ...(block.alt && { caption: block.alt }),
          ...(buildAttachmentDebugInfo(block) ? { debug: buildAttachmentDebugInfo(block) } : {}),
        });
        break;

      case "audio":
        instructions.push({
          kind: "audio",
          audio: await readBlockBuffer(block),
          mimetype: block.mime_type || "audio/mp4",
          ...(buildAttachmentDebugInfo(block) ? { debug: buildAttachmentDebugInfo(block) } : {}),
        });
        break;

      case "file":
        instructions.push({
          kind: "file",
          file: await readBlockBuffer(block),
          mimetype: block.mime_type || "application/octet-stream",
          fileName: block.file_name || "file",
          ...(block.caption && { caption: block.caption }),
          ...(buildAttachmentDebugInfo(block) ? { debug: buildAttachmentDebugInfo(block) } : {}),
        });
        break;
    }
  }

  return instructions;
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @param {SendInstruction[]} instructions
 * @param {{ caption?: string, sourcePath?: string }} [options]
 * @returns {Promise<void>}
 */
async function appendAttachmentInstruction(block, instructions, options = {}) {
  const debugInfo = buildAttachmentDebugInfo(block, {
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
  });

  switch (block.type) {
    case "image":
      instructions.push({
        kind: "image",
        image: await readBlockBuffer(block),
        ...((options.caption ?? block.alt) ? { caption: options.caption ?? block.alt } : {}),
        ...(block.quality === "hd" && { hd: true }),
        ...(debugInfo ? { debug: debugInfo } : {}),
        editable: false,
      });
      return;
    case "video":
      instructions.push({
        kind: "video",
        video: await readBlockBuffer(block),
        mimetype: block.mime_type || "video/mp4",
        ...((options.caption ?? block.alt) ? { caption: options.caption ?? block.alt } : {}),
        ...(debugInfo ? { debug: debugInfo } : {}),
      });
      return;
    case "audio":
      instructions.push({
        kind: "audio",
        audio: await readBlockBuffer(block),
        mimetype: block.mime_type || "audio/mp4",
        ...(debugInfo ? { debug: debugInfo } : {}),
      });
      return;
    case "file":
      instructions.push({
        kind: "file",
        file: await readBlockBuffer(block),
        mimetype: block.mime_type || "application/octet-stream",
        fileName: block.file_name || "file",
        ...((options.caption ?? block.caption) ? { caption: options.caption ?? block.caption } : {}),
        ...(debugInfo ? { debug: debugInfo } : {}),
      });
      return;
  }
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
  let textBuffer = "";

  const flushText = () => {
    const trimmed = textBuffer.trim();
    if (trimmed) {
      instructions.push({ kind: "text", text: prependSourcePrefix(prefix, trimmed), editable: true });
    }
    textBuffer = "";
  };

  /**
   * @param {string} fragment
   * @returns {void}
   */
  const appendTextFragment = (fragment) => {
    const trimmed = fragment.trim();
    if (trimmed) {
      textBuffer += (textBuffer ? "\n" : "") + trimmed;
    }
  };

  /**
   * @param {string} markdown
   * @returns {void}
   */
  const appendMarkdownText = (markdown) => {
    appendTextFragment(markdownToWhatsApp(markdown));
  };

  for (const segment of segmentMarkdown(text)) {
    switch (segment.kind) {
      case "text":
        appendMarkdownText(segment.text);
        break;

      case "code_block":
        if (segment.language && shouldRenderAsImage(segment.language, segment.code)) {
          flushText();
          try {
            const images = await renderCodeToImages(segment.code, segment.language);
            for (const image of images) {
              instructions.push({
                kind: "image",
                image,
                ...(segment.language && { caption: segment.language }),
                editable: false,
              });
            }
          } catch (error) {
            log.error("Markdown code image rendering failed, falling back to text:", error);
            appendTextFragment("```\n" + segment.code + "\n```");
          }
          break;
        }

        appendTextFragment("```\n" + segment.code + "\n```");
        break;

      case "table":
        flushText();
        try {
          const images = renderTableToImages(segment.text);
          for (const image of images) {
            instructions.push({
              kind: "image",
              image,
              editable: false,
            });
          }
        } catch (error) {
          log.error("Table image rendering failed, falling back to text:", error);
          appendMarkdownText(segment.text);
        }
        break;

      case "display_math":
        flushText();
        try {
          instructions.push({
            kind: "image",
            image: await renderDisplayMathToImage(segment.tex),
            editable: false,
          });
        } catch (error) {
          log.error("Display math rendering failed, falling back to text:", error);
          appendMarkdownText(segment.rawText);
        }
        break;

      case "attachment_directive":
        flushText();
        try {
          log.info("Resolving attachment directive", { path: segment.path });
          const block = await resolvePathToContentBlock(segment.path);
          log.info("Resolved attachment directive", {
            path: segment.path,
            kind: block.type,
            ...(buildAttachmentDebugInfo(block) ?? {}),
          });
          await appendAttachmentInstruction(block, instructions, {
            ...(segment.caption ? { caption: segment.caption } : {}),
            sourcePath: segment.path,
          });
        } catch (error) {
          log.error("Attachment directive rendering failed:", {
            path: segment.path,
            error: formatErrorMessage(error),
          });
          instructions.push({
            kind: "text",
            text: prependSourcePrefix(prefix, `Attachment send failed for \`${segment.path}\`: ${formatErrorMessage(error)}`),
            editable: false,
          });
        }
        break;
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
