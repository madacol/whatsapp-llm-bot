import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveMediaPath } from "../../../attachment-paths.js";
import { readMediaBuffer } from "../../../media-store.js";

/**
 * @param {unknown} result
 * @returns {ToolContentBlock[]}
 */
function getResultBlocks(result) {
  if (typeof result !== "object" || result === null || !("result" in result)) {
    throw new Error("Expected action to return { result }");
  }
  const blocks = result.result;
  if (!Array.isArray(blocks)) {
    throw new Error("Expected action result to contain content blocks");
  }
  return blocks;
}

/**
 * @param {ToolContentBlock | undefined} block
 * @returns {ImageContentBlock & { path: string }}
 */
function assertStoredImageBlock(block) {
  assert.ok(block, "Expected an image block");
  assert.equal(block.type, "image");
  assert.ok("path" in block, "Expected image block to use stored media");
  return block;
}

/**
 * @param {ToolContentBlock | undefined} block
 * @returns {FileContentBlock & { path: string, file_name: string, mime_type: string }}
 */
function assertStoredFileBlock(block) {
  assert.ok(block, "Expected a file block");
  assert.equal(block.type, "file");
  assert.ok("path" in block, "Expected file block to use stored media");
  const fileName = block.file_name;
  const mimeType = block.mime_type;
  if (typeof fileName !== "string") {
    throw new Error("Expected stored file block to include file_name");
  }
  if (typeof mimeType !== "string") {
    throw new Error("Expected stored file block to include mime_type");
  }
  return { ...block, path: block.path, file_name: fileName, mime_type: mimeType };
}

/** @type {ActionTestFn[]} */
export default [
  async function sends_image_paths_as_image_blocks(action_fn) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "send-path-image-"));
    const imagePath = path.join(tempDir, "photo.png");
    try {
      await fs.writeFile(imagePath, Buffer.from("fake-image"));
      const result = await action_fn(
        {
          content: [],
          log: async () => "",
          workdir: tempDir,
        },
        { path: "./photo.png" },
      );

      const blocks = getResultBlocks(result);
      assert.equal(blocks.length, 1);
      const imageBlock = assertStoredImageBlock(blocks[0]);
      assert.equal(imageBlock.mime_type, "image/png");
      await fs.rm(resolveMediaPath(imageBlock.path), { force: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },

  async function sends_generic_files_as_file_blocks(action_fn) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "send-path-file-"));
    const sheetPath = path.join(tempDir, "sheet.xlsx");
    try {
      await fs.writeFile(sheetPath, Buffer.from("fake-sheet"));
      const result = await action_fn(
        {
          content: [],
          log: async () => "",
          workdir: tempDir,
        },
        { path: "./sheet.xlsx" },
      );

      const blocks = getResultBlocks(result);
      assert.equal(blocks.length, 1);
      const fileBlock = assertStoredFileBlock(blocks[0]);
      assert.equal(fileBlock.file_name, "sheet.xlsx");
      assert.equal(fileBlock.mime_type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      await fs.rm(resolveMediaPath(fileBlock.path), { force: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },

  async function zips_directories_and_returns_file_blocks(action_fn) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "send-path-dir-"));
    const folderPath = path.join(tempDir, "bundle");
    try {
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, "a.txt"), "hello");
      await fs.writeFile(path.join(folderPath, "b.txt"), "world");
      const result = await action_fn(
        {
          content: [],
          log: async () => "",
          workdir: tempDir,
        },
        { path: "./bundle" },
      );

      const blocks = getResultBlocks(result);
      assert.equal(blocks.length, 1);
      const fileBlock = assertStoredFileBlock(blocks[0]);
      assert.equal(fileBlock.file_name, "bundle.zip");
      assert.equal(fileBlock.mime_type, "application/zip");
      const zipBuffer = await readMediaBuffer(fileBlock.path);
      assert.equal(zipBuffer.subarray(0, 2).toString("utf8"), "PK");
      await fs.rm(resolveMediaPath(fileBlock.path), { force: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
];
