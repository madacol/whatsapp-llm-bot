import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEDIA_FILE_RE = /^[a-f0-9]{64}\.[a-z0-9]{1,32}$/;
const MEDIA_ROOT = fileURLToPath(new URL("./.media/", import.meta.url));

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
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
};

/** @type {Record<string, string>} */
const EXT_TO_MIME = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mimeType, ext]) => [ext, mimeType]),
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
  return MEDIA_FILE_RE.test(mediaPath);
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
  return path.join(MEDIA_ROOT, validated);
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
 * @param {Buffer} buffer
 * @returns {string}
 */
export function hashMediaBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * @param {Buffer} buffer
 * @param {string | undefined} mimeType
 * @param {"image" | "video" | "audio" | "file"} blockType
 * @param {string | undefined} [fileName]
 * @returns {string}
 */
export function deriveMediaPath(buffer, mimeType, blockType, fileName) {
  const sha = hashMediaBuffer(buffer);
  const ext = mimeTypeToExtension(mimeType, blockType, fileName);
  return `${sha}.${ext}`;
}

/**
 * @returns {Promise<void>}
 */
export async function ensureMediaRoot() {
  await mkdir(MEDIA_ROOT, { recursive: true });
}

/**
 * @param {Buffer} buffer
 * @param {string | undefined} mimeType
 * @param {"image" | "video" | "audio" | "file"} blockType
 * @param {string | undefined} [fileName]
 * @returns {Promise<string>}
 */
export async function writeMedia(buffer, mimeType, blockType, fileName) {
  const mediaPath = deriveMediaPath(buffer, mimeType, blockType, fileName);
  const absolutePath = resolveMediaPath(mediaPath);
  await ensureMediaRoot();
  try {
    await stat(absolutePath);
  } catch {
    await writeFile(absolutePath, buffer);
  }
  return mediaPath;
}

/**
 * @param {string} mediaPath
 * @returns {Promise<Buffer>}
 */
export async function readMediaBuffer(mediaPath) {
  return readFile(resolveMediaPath(mediaPath));
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {Promise<Buffer>}
 */
export async function readBlockBuffer(block) {
  if (hasMediaPath(block)) {
    return readMediaBuffer(block.path);
  }
  if (hasInlineMediaData(block)) {
    return Buffer.from(block.data, "base64");
  }
  throw new Error("Media block has neither path nor inline data");
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {Promise<string>}
 */
export async function readBlockBase64(block) {
  if (hasInlineMediaData(block)) {
    return block.data;
  }
  return (await readBlockBuffer(block)).toString("base64");
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock} block
 * @returns {Promise<string>}
 */
export async function ensureMediaPathForBlock(block) {
  if (hasMediaPath(block)) {
    validateMediaPath(block.path);
    return block.path;
  }
  const mediaPath = await writeMedia(
    Buffer.from(await readBlockBase64(block), "base64"),
    block.mime_type,
    block.type,
    "file_name" in block ? block.file_name : undefined,
  );
  const withPath = /** @type {(ImageContentBlock | VideoContentBlock | AudioContentBlock | FileContentBlock) & { path?: string }} */ (block);
  withPath.path = mediaPath;
  return mediaPath;
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock} block
 * @returns {Promise<string>}
 */
export async function blockToDataUrl(block) {
  const mimeType = hasMediaPath(block)
    ? mediaPathToMimeType(block.path, block.mime_type)
    : block.mime_type || mediaPathToMimeType(await ensureMediaPathForBlock(block), block.mime_type);
  return `data:${mimeType};base64,${await readBlockBase64(block)}`;
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock} block
 * @returns {Promise<string>}
 */
export async function hashMediaBlock(block) {
  if (hasMediaPath(block)) {
    return block.path.slice(0, 64);
  }
  return hashMediaBuffer(await readBlockBuffer(block));
}

/**
 * @param {string} mediaPath
 * @returns {ImageContentBlock}
 */
export function createImageBlockFromPath(mediaPath) {
  return {
    type: "image",
    path: validateMediaPath(mediaPath),
    mime_type: mediaPathToMimeType(mediaPath, "image/jpeg"),
  };
}
