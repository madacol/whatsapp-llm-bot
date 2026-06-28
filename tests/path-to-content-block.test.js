import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePathToContentBlock } from "../outbound/path-to-content-block.js";

/**
 * @typedef {{ buffer: Buffer, mimeType: string | undefined, blockType: "image" | "video" | "audio" | "file", fileName: string | undefined }} StoredMediaCapture
 */

/**
 * @param {Buffer} buffer
 * @returns {import("../outbound/path-to-content-block.js").PathToContentBlockDeps}
 */
function createFileDeps(buffer) {
  return {
    statPath: async () => ({
      isDirectory: () => false,
      isFile: () => true,
    }),
    readFilePath: async () => buffer,
    writeStoredMedia: async () => "a".repeat(64) + ".bin",
  };
}

describe("resolvePathToContentBlock", () => {
  it("rasterizes .svg attachments to PNG image blocks", async () => {
    const svg = Buffer.from([
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8">',
      '<rect width="12" height="8" fill="#0f766e"/>',
      "</svg>",
    ].join(""));
    /** @type {{ value: StoredMediaCapture | null }} */
    const stored = { value: null };
    const block = await resolvePathToContentBlock("/repo/badge.svg", {}, {
      statPath: async () => ({
        isDirectory: () => false,
        isFile: () => true,
      }),
      readFilePath: async () => svg,
      writeStoredMedia: async (buffer, mimeType, blockType, fileName) => {
        stored.value = { buffer, mimeType, blockType, fileName };
        return "a".repeat(64) + ".png";
      },
    });

    assert.equal(block.type, "image");
    assert.ok("path" in block);
    assert.equal(block.mime_type, "image/png");
    assert.equal(block.path.endsWith(".png"), true);
    assert.equal(stored.value?.mimeType, "image/png");
    assert.equal(stored.value?.blockType, "image");
    assert.equal(stored.value?.fileName, "badge.png");
    assert.deepEqual(stored.value?.buffer.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("normalizes .mp3 attachments to audio/mpeg for outbound sends", async () => {
    const block = await resolvePathToContentBlock("/repo/clip.mp3", {}, createFileDeps(Buffer.from("mp3-data")));

    assert.equal(block.type, "audio");
    assert.equal(block.mime_type, "audio/mpeg");
  });

  it("normalizes .m4a attachments to audio/mp4 for outbound sends", async () => {
    const block = await resolvePathToContentBlock("/repo/clip.m4a", {}, createFileDeps(Buffer.from("m4a-data")));

    assert.equal(block.type, "audio");
    assert.equal(block.mime_type, "audio/mp4");
  });

  it("marks Opus-in-Ogg attachments with codecs=opus", async () => {
    const block = await resolvePathToContentBlock(
      "/repo/clip.ogg",
      {},
      createFileDeps(Buffer.concat([
        Buffer.from("OggS", "ascii"),
        Buffer.alloc(24),
        Buffer.from("OpusHead", "ascii"),
      ])),
    );

    assert.equal(block.type, "audio");
    assert.equal(block.mime_type, "audio/ogg; codecs=opus");
  });

  it("treats .wav attachments as files instead of native audio", async () => {
    const block = await resolvePathToContentBlock("/repo/clip.wav", {}, createFileDeps(Buffer.from("wav-data")));

    assert.equal(block.type, "file");
    assert.equal(block.mime_type, "audio/wav");
    assert.equal(block.file_name, "clip.wav");
  });
});
