import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePathToContentBlock } from "../outbound/path-to-content-block.js";

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
