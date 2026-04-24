import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileNameToMimeType } from "../attachment-paths.js";
import { writeMedia } from "../media-store.js";

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const OGGS_MAGIC = Buffer.from("OggS", "ascii");
const OPUS_HEAD_MAGIC = Buffer.from("OpusHead", "ascii");

/**
 * @typedef {{
 *   statPath?: typeof stat;
 *   readFilePath?: typeof readFile;
 *   writeStoredMedia?: typeof writeMedia;
 *   makeTempDir?: typeof mkdtemp;
 *   removePath?: typeof rm;
 *   archiveDirectoryToZip?: (sourceDir: string, zipPath: string) => Promise<void>;
 * }} PathToContentBlockDeps
 */

/**
 * @param {string} inputPath
 * @param {string | null | undefined} workdir
 * @returns {string}
 */
function resolveInputPath(inputPath, workdir) {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workdir ?? process.cwd(), inputPath);
}

/**
 * @param {string} filePath
 * @returns {"image" | "audio" | "video" | "file"}
 */
function classifyFilePath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return "file";
}

/**
 * @param {Buffer} haystack
 * @param {Buffer} needle
 * @returns {boolean}
 */
function bufferIncludes(haystack, needle) {
  return haystack.indexOf(needle) !== -1;
}

/**
 * @param {string} filePath
 * @param {Buffer} buffer
 * @returns {string | undefined}
 */
function inferCanonicalAudioMimeType(filePath, buffer) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".m4a") {
    return "audio/mp4";
  }
  if (extension === ".ogg" && bufferIncludes(buffer, OGGS_MAGIC) && bufferIncludes(buffer, OPUS_HEAD_MAGIC)) {
    return "audio/ogg; codecs=opus";
  }
  return undefined;
}

/**
 * @param {string} sourceDir
 * @param {string} zipPath
 * @returns {Promise<void>}
 */
async function archiveDirectoryToZip(sourceDir, zipPath) {
  const script = [
    "import os, sys, zipfile",
    "source_dir, zip_path = sys.argv[1], sys.argv[2]",
    "base = os.path.basename(os.path.normpath(source_dir))",
    "with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:",
    "    wrote_entry = False",
    "    for root, dirs, files in os.walk(source_dir):",
    "        dirs.sort()",
    "        files.sort()",
    "        rel_root = os.path.relpath(root, source_dir)",
    "        archive_root = base if rel_root == '.' else base + '/' + rel_root",
    "        if not dirs and not files:",
    "            archive.writestr(archive_root + '/', '')",
    "            wrote_entry = True",
    "        for name in files:",
    "            full_path = os.path.join(root, name)",
    "            archive.write(full_path, archive_root + '/' + name)",
    "            wrote_entry = True",
    "    if not wrote_entry:",
    "        archive.writestr(base + '/', '')",
  ].join("\n");

  await execFileAsync("python3", ["-c", script, sourceDir, zipPath]);
}

/**
 * @param {string} resolvedPath
 * @param {string} displayName
 * @param {PathToContentBlockDeps} deps
 * @returns {Promise<FileContentBlock>}
 */
async function stageDirectoryAsZip(resolvedPath, displayName, deps) {
  const makeTempDir = deps.makeTempDir ?? mkdtemp;
  const removePath = deps.removePath ?? rm;
  const archive = deps.archiveDirectoryToZip ?? archiveDirectoryToZip;
  const readFilePath = deps.readFilePath ?? readFile;
  const writeStoredMedia = deps.writeStoredMedia ?? writeMedia;
  const tempDir = await makeTempDir(path.join(os.tmpdir(), "attachment-zip-"));
  const zipName = `${displayName}.zip`;
  const zipPath = path.join(tempDir, zipName);

  try {
    await archive(resolvedPath, zipPath);
    const buffer = await readFilePath(zipPath);
    const storedPath = await writeStoredMedia(buffer, "application/zip", "file", zipName);
    return {
      type: "file",
      path: storedPath,
      mime_type: "application/zip",
      file_name: zipName,
    };
  } finally {
    await removePath(tempDir, { recursive: true, force: true });
  }
}

/**
 * @param {string} inputPath
 * @param {{ workdir?: string | null }} [options]
 * @param {PathToContentBlockDeps} [deps]
 * @returns {Promise<ImageContentBlock | AudioContentBlock | VideoContentBlock | FileContentBlock>}
 */
export async function resolvePathToContentBlock(inputPath, options = {}, deps = {}) {
  const statPath = deps.statPath ?? stat;
  const readFilePath = deps.readFilePath ?? readFile;
  const writeStoredMedia = deps.writeStoredMedia ?? writeMedia;
  const resolvedPath = resolveInputPath(inputPath, options.workdir ?? null);
  const stats = await statPath(resolvedPath);
  const displayName = path.basename(resolvedPath);

  if (stats.isDirectory()) {
    return stageDirectoryAsZip(resolvedPath, displayName, deps);
  }

  if (!stats.isFile()) {
    throw new Error(`Path is neither a file nor a directory: ${resolvedPath}`);
  }

  const buffer = await readFilePath(resolvedPath);
  const kind = classifyFilePath(resolvedPath);
  const mimeType = kind === "audio"
    ? inferCanonicalAudioMimeType(resolvedPath, buffer) ?? fileNameToMimeType(displayName, undefined)
    : fileNameToMimeType(displayName, kind === "file" ? "application/octet-stream" : undefined);
  const storedPath = await writeStoredMedia(buffer, mimeType, kind, displayName);

  switch (kind) {
    case "image":
      return { type: "image", path: storedPath, mime_type: mimeType };
    case "audio":
      return { type: "audio", path: storedPath, mime_type: mimeType };
    case "video":
      return { type: "video", path: storedPath, mime_type: mimeType };
    default:
      return {
        type: "file",
        path: storedPath,
        mime_type: mimeType,
        file_name: displayName,
      };
  }
}
