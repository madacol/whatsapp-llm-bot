import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  ATTACHMENT_ROOT,
  deriveMediaPath,
  hasInlineMediaData,
  hasMediaPath,
  mediaPathToMimeType,
  resolveMediaPath,
  validateMediaPath,
} from "./attachment-paths.js";

export {
  deriveMediaPath,
  hasInlineMediaData,
  hasMediaPath,
  isBinaryMediaBlock,
  isValidMediaPath,
  mediaPathToMimeType,
  mimeTypeToExtension,
  resolveMediaPath,
  validateMediaPath,
} from "./attachment-paths.js";

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
export function hashMediaBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * @returns {Promise<void>}
 */
export async function ensureMediaRoot() {
  await mkdir(ATTACHMENT_ROOT, { recursive: true });
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
