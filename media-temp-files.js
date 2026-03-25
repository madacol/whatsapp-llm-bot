import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const TEMP_MEDIA_DIR = path.join(tmpdir(), "whatsapp-llm-bot-media");

/** @type {Record<string, string>} */
const MIME_TYPE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
};

/** @type {Record<string, string>} */
const IMAGE_MIME_TYPES_BY_EXTENSION = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/**
 * @param {unknown} block
 * @returns {block is ImageContentBlock}
 */
export function isImageContentBlock(block) {
  if (typeof block !== "object" || block === null) {
    return false;
  }
  if (!("type" in block) || block.type !== "image") {
    return false;
  }
  if (!("encoding" in block) || block.encoding !== "base64") {
    return false;
  }
  if (!("mime_type" in block) || typeof block.mime_type !== "string") {
    return false;
  }
  if (!("data" in block) || typeof block.data !== "string") {
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {value is ImageContentBlock}
 */
export function isImageInputBlock(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("type" in value) || value.type !== "image") {
    return false;
  }
  if (!("encoding" in value) || value.encoding !== "base64") {
    return false;
  }
  if (!("mime_type" in value) || typeof value.mime_type !== "string") {
    return false;
  }
  if (!("data" in value) || typeof value.data !== "string") {
    return false;
  }
  return true;
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock} block
 * @returns {string}
 */
function getMediaMimeType(block) {
  if (typeof block.mime_type === "string" && block.mime_type.trim()) {
    return block.mime_type.split(";")[0].trim().toLowerCase();
  }
  if (block.type === "image") return "image/jpeg";
  if (block.type === "video") return "video/mp4";
  return "audio/mp3";
}

/**
 * @param {string} mimeType
 * @returns {string}
 */
function getExtensionForMimeType(mimeType) {
  return MIME_TYPE_EXTENSIONS[mimeType] ?? "bin";
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function getImageMimeTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_TYPES_BY_EXTENSION[extension] ?? "image/jpeg";
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock} block
 * @returns {string}
 */
function getMediaHash(block) {
  return createHash("sha256")
    .update(block.type)
    .update("\0")
    .update(getMediaMimeType(block))
    .update("\0")
    .update(block.data)
    .digest("hex");
}

/**
 * @returns {string}
 */
export function getTempMediaDirectory() {
  return TEMP_MEDIA_DIR;
}

/**
 * @param {ImageContentBlock | VideoContentBlock | AudioContentBlock} block
 * @returns {Promise<string>}
 */
export async function writeMediaBlockToTempFile(block) {
  const mimeType = getMediaMimeType(block);
  const extension = getExtensionForMimeType(mimeType);
  const filePath = path.join(TEMP_MEDIA_DIR, `${getMediaHash(block)}.${extension}`);

  await mkdir(TEMP_MEDIA_DIR, { recursive: true });
  await writeFile(filePath, Buffer.from(block.data, "base64"));

  return filePath;
}

/**
 * @param {string} filePath
 * @returns {Promise<ImageContentBlock>}
 */
export async function readImageFileAsBlock(filePath) {
  const fileBytes = await readFile(filePath);
  return {
    type: "image",
    encoding: "base64",
    mime_type: getImageMimeTypeForPath(filePath),
    data: fileBytes.toString("base64"),
  };
}

/**
 * @param {string | ImageContentBlock} input
 * @returns {Promise<ImageContentBlock>}
 */
export async function normalizeImageInput(input) {
  if (typeof input === "string") {
    return readImageFileAsBlock(input);
  }
  return input;
}

/**
 * @param {Array<string | ImageContentBlock>} inputs
 * @returns {Promise<ImageContentBlock[]>}
 */
export async function normalizeImageInputs(inputs) {
  return Promise.all(inputs.map(normalizeImageInput));
}
