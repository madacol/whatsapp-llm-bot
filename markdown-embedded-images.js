import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createLogger } from "./logger.js";

const log = createLogger("markdown-embedded-images");
const EMBEDDED_MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/gi;
const LOCAL_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

/**
 * @typedef {
 *   | { kind: "text", text: string }
 *   | { kind: "image", image: Buffer, caption?: string }
 * } MarkdownInlineSegment
 */

/**
 * @param {string} target
 * @returns {boolean}
 */
function isInlineDataUrl(target) {
  return /^data:/i.test(target);
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
 * @param {string} dataUrl
 * @returns {{ mimeType: string, buffer: Buffer }}
 */
function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+)((?:;[^;,=]+=[^;,]+)*)(;base64)?,(.*)$/is);
  if (!match) {
    throw new Error("Invalid data URL");
  }

  const mimeType = match[1] || "text/plain";
  const isBase64 = match[3] === ";base64";
  const payload = match[4] || "";
  return {
    mimeType,
    buffer: isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8"),
  };
}

/**
 * @param {Buffer} svgBuffer
 * @returns {Buffer}
 */
function renderSvgToPng(svgBuffer) {
  const resvg = new Resvg(svgBuffer);
  return resvg.render().asPng();
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isLocalImageTarget(target) {
  if (!isLocalFileTarget(target)) {
    return false;
  }

  const normalizedTarget = stripLocalFileLocation(target).toLowerCase();
  return [...LOCAL_IMAGE_EXTENSIONS].some((extension) => normalizedTarget.endsWith(extension));
}

/**
 * @param {string} target
 * @returns {Promise<Buffer | null>}
 */
async function resolveEmbeddedMarkdownImage(target) {
  if (isInlineDataUrl(target)) {
    const { mimeType, buffer } = parseDataUrl(target);
    if (!mimeType.startsWith("image/")) {
      return null;
    }
    return mimeType === "image/svg+xml" ? renderSvgToPng(buffer) : buffer;
  }

  if (!isLocalImageTarget(target)) {
    return null;
  }

  const filePath = stripLocalFileLocation(target);
  const buffer = await readFile(filePath);
  return filePath.toLowerCase().endsWith(".svg") ? renderSvgToPng(buffer) : buffer;
}

/**
 * Split a text run into plain text and embedded markdown image segments.
 * `data:image/...` payloads and absolute local image paths are turned into
 * outbound image segments here.
 * @param {string} text
 * @returns {Promise<MarkdownInlineSegment[]>}
 */
export async function splitEmbeddedMarkdownImages(text) {
  /** @type {MarkdownInlineSegment[]} */
  const segments = [];
  let lastIndex = 0;

  for (const match of text.matchAll(EMBEDDED_MARKDOWN_IMAGE_RE)) {
    const fullMatch = match[0];
    const alt = (match[1] || "").trim();
    const target = match[2];
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, matchIndex) });
    }

    try {
      const image = await resolveEmbeddedMarkdownImage(target);
      if (image) {
        segments.push({
          kind: "image",
          image,
          ...(alt ? { caption: alt } : {}),
        });
      } else {
        segments.push({ kind: "text", text: fullMatch });
      }
    } catch (error) {
      log.error("Embedded markdown image rendering failed, falling back to text:", error);
      segments.push({ kind: "text", text: fullMatch });
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", text }];
}
