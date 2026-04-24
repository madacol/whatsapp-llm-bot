import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ATTACHMENT_FILE_RE = /^[a-f0-9]{64}\.[a-z0-9]{1,32}$/;
export const ATTACHMENT_ROOT = fileURLToPath(new URL("./.media/", import.meta.url));

/** @type {Record<string, string>} */
const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/ogg; codecs=opus": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
  "application/zip": "zip",
};

/** @type {Record<string, string>} */
const EXT_TO_MIME = Object.entries(MIME_TO_EXT).reduce(
  /**
   * @param {Record<string, string>} map
   * @param {[string, string]} entry
   * @returns {Record<string, string>}
   */
  (map, [mimeType, ext]) => {
    if (!(ext in map)) {
      map[ext] = mimeType;
    }
    return map;
  },
  {},
);

/**
 * @param {IncomingContentBlock | ToolContentBlock} block
 * @returns {block is ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock}
 */
export function isBinaryMediaBlock(block) {
  return block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file";
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {block is (ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock) & { path: string }}
 */
export function hasMediaPath(block) {
  return "path" in block && typeof block.path === "string";
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {block is (ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock) & { encoding: "base64", data: string }}
 */
export function hasInlineMediaData(block) {
  return "data" in block
    && typeof block.data === "string"
    && (!("encoding" in block) || block.encoding === "base64");
}

/**
 * @param {string} mediaPath
 * @returns {boolean}
 */
export function isValidMediaPath(mediaPath) {
  return ATTACHMENT_FILE_RE.test(mediaPath);
}

/**
 * @param {string} mediaPath
 * @returns {string}
 */
export function validateMediaPath(mediaPath) {
  if (!isValidMediaPath(mediaPath)) {
    throw new Error(`Invalid media path: ${mediaPath}`);
  }
  return mediaPath;
}

/**
 * @param {string} mediaPath
 * @returns {string}
 */
export function resolveMediaPath(mediaPath) {
  const validated = validateMediaPath(mediaPath);
  return path.join(ATTACHMENT_ROOT, validated);
}

/**
 * @param {string | undefined} extension
 * @returns {string | null}
 */
function normalizeExtensionCandidate(extension) {
  if (!extension) {
    return null;
  }
  const normalized = extension.replace(/^\./, "").trim().toLowerCase();
  return /^[a-z0-9]{1,32}$/.test(normalized) ? normalized : null;
}

/**
 * @param {string | undefined} fileName
 * @returns {string | null}
 */
function extensionFromFileName(fileName) {
  const baseName = typeof fileName === "string" ? path.basename(fileName) : "";
  if (!baseName.includes(".")) {
    return null;
  }
  return normalizeExtensionCandidate(baseName.split(".").pop());
}

/**
 * @param {string | undefined} mimeType
 * @param {"image" | "video" | "audio" | "file"} [blockType]
 * @param {string | undefined} [fileName]
 * @returns {string}
 */
export function mimeTypeToExtension(mimeType, blockType, fileName) {
  if (mimeType && MIME_TO_EXT[mimeType]) {
    return MIME_TO_EXT[mimeType];
  }
  if (blockType === "image") return "jpg";
  if (blockType === "video") return "mp4";
  if (blockType === "audio") return "mp3";
  if (blockType === "file") {
    return extensionFromFileName(fileName) || "bin";
  }
  throw new Error(`Unsupported media MIME type: ${mimeType ?? "(missing)"}`);
}

/**
 * @param {string} mediaPath
 * @param {string | undefined} fallbackMimeType
 * @returns {string}
 */
export function mediaPathToMimeType(mediaPath, fallbackMimeType) {
  const ext = validateMediaPath(mediaPath).split(".").at(-1);
  return (ext && EXT_TO_MIME[ext]) || fallbackMimeType || "application/octet-stream";
}

/**
 * @param {string} fileName
 * @param {string | undefined} fallbackMimeType
 * @returns {string}
 */
export function fileNameToMimeType(fileName, fallbackMimeType) {
  const ext = normalizeExtensionCandidate(path.extname(fileName));
  return (ext && EXT_TO_MIME[ext]) || fallbackMimeType || "application/octet-stream";
}

/**
 * @param {Buffer} buffer
 * @param {string | undefined} mimeType
 * @param {"image" | "video" | "audio" | "file"} blockType
 * @param {string | undefined} [fileName]
 * @returns {string}
 */
export function deriveMediaPath(buffer, mimeType, blockType, fileName) {
  const sha = createHash("sha256").update(buffer).digest("hex");
  const ext = mimeTypeToExtension(mimeType, blockType, fileName);
  return `${sha}.${ext}`;
}
