import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Resvg } from "@resvg/resvg-js";
const EMBEDDED_MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/gi;
const LOCAL_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

/**
 * @typedef {
 *   | { kind: "text", text: string }
 *   | { kind: "embedded_image", target: string, rawText: string, caption?: string }
 * } MarkdownEmbeddedImageSegment
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
  if (!dataUrl.startsWith("data:")) {
    throw new Error("Invalid data URL");
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    throw new Error("Invalid data URL");
  }

  const header = dataUrl.slice("data:".length, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const headerParts = header.split(";").filter(Boolean);
  const hasExplicitMimeType = headerParts.length > 0 && headerParts[0].includes("/");
  const mimeType = hasExplicitMimeType ? headerParts[0] : "text/plain";
  const metadataParts = hasExplicitMimeType ? headerParts.slice(1) : headerParts;
  const isBase64 = metadataParts.some((part) => part.toLowerCase() === "base64");

  return {
    mimeType: mimeType || "text/plain",
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
export async function resolveEmbeddedMarkdownImage(target) {
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
 * `data:image/...` payloads and absolute local image paths are recognized here,
 * but resolved into buffers later by the renderer.
 * @param {string} text
 * @returns {MarkdownEmbeddedImageSegment[]}
 */
export function splitEmbeddedMarkdownImages(text) {
  /** @type {MarkdownEmbeddedImageSegment[]} */
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

    segments.push({
      kind: "embedded_image",
      target,
      rawText: fullMatch,
      ...(alt ? { caption: alt } : {}),
    });

    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", text }];
}
