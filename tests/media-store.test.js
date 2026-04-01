import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { isValidMediaPath, resolveMediaPath } from "../attachment-paths.js";
import {
  readMediaBuffer,
  writeMedia,
} from "../media-store.js";

/** @type {Set<string>} */
const createdPaths = new Set();

afterEach(async () => {
  await Promise.all(
    [...createdPaths].map(async (mediaPath) => {
      await rm(resolveMediaPath(mediaPath), { force: true });
    }),
  );
  createdPaths.clear();
});

describe("media-store", () => {
  it("accepts only canonical media file names", () => {
    assert.equal(isValidMediaPath("a".repeat(64) + ".jpg"), true);
    assert.equal(isValidMediaPath("A".repeat(64) + ".jpg"), false);
    assert.equal(isValidMediaPath("../" + "a".repeat(64) + ".jpg"), false);
    assert.equal(isValidMediaPath("nested/" + "a".repeat(64) + ".jpg"), false);
    assert.equal(isValidMediaPath("/tmp/file.jpg"), false);
  });

  it("deduplicates identical media by hash-based filename", async () => {
    const buffer = Buffer.from("same-bytes");
    const firstPath = await writeMedia(buffer, "image/jpeg", "image");
    const secondPath = await writeMedia(buffer, "image/jpeg", "image");
    createdPaths.add(firstPath);

    assert.equal(firstPath, secondPath);
    assert.match(firstPath, /^[a-f0-9]{64}\.jpg$/);
    assert.deepEqual(await readMediaBuffer(firstPath), buffer);
  });
});
