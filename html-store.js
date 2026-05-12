import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import config from "./config.js";
import { getChatRootDir } from "./chat-paths.js";

const UNSAFE_HTML_PATTERNS = [
  /<\s*script\b/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
];

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {string} html
 * @returns {string | null}
 */
export function getUnsafeHtmlReason(html) {
  for (const pattern of UNSAFE_HTML_PATTERNS) {
    if (pattern.test(html)) {
      return "HTML pages must be static: script tags, inline event handlers, and javascript: URLs are not allowed.";
    }
  }
  return null;
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function getHtmlPagesDir(chatId) {
  return join(getChatRootDir(chatId), "html");
}

/**
 * @param {string} chatId
 * @param {string} hash
 * @returns {string}
 */
export function getHtmlPagePath(chatId, hash) {
  return join(getHtmlPagesDir(chatId), `${hash}.html`);
}

/**
 * Store an HTML page file and return its content hash.
 * @param {string} chatId
 * @param {string} html
 * @param {string} [title]
 * @returns {Promise<string>} SHA-256 hash of the stored page file.
 */
export async function storePage(chatId, html, title) {
  const unsafeReason = getUnsafeHtmlReason(html);
  if (unsafeReason) {
    throw new Error(unsafeReason);
  }
  const titleTag = title ? `<title>${escapeHtml(title)}</title>` : "";
  const trimmedHtml = html.trim();
  const isFullDocument = /^\s*(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i.test(trimmedHtml);
  const pageHtml = isFullDocument
    ? trimmedHtml
    : `<!DOCTYPE html><html><head><meta charset="utf-8">${titleTag}</head><body>${trimmedHtml}</body></html>`;
  const hash = createHash("sha256").update(pageHtml).digest("hex");
  await mkdir(getHtmlPagesDir(chatId), { recursive: true });
  await writeFile(getHtmlPagePath(chatId, hash), pageHtml);
  return hash;
}

/**
 * Store an HTML page file and return a display link.
 * @param {string} chatId
 * @param {HtmlContent} htmlContent
 * @returns {Promise<string>}
 */
export async function storeAndLinkHtml(chatId, htmlContent) {
  const pageHash = await storePage(chatId, htmlContent.html, htmlContent.title);
  const baseUrl = config.html_server_base_url || `http://localhost:${config.html_server_port}`;
  const pageUrl = `${baseUrl}/chat/${encodeURIComponent(chatId)}/html/${pageHash}.html`;
  return htmlContent.title ? `${htmlContent.title}: ${pageUrl}` : pageUrl;
}

/**
 * Retrieve an HTML page file by content hash.
 * @param {string} chatId
 * @param {string} hash
 * @returns {Promise<string | null>}
 */
export async function getPage(chatId, hash) {
  try {
    return await readFile(getHtmlPagePath(chatId, hash), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
