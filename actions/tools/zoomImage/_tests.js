import assert from "node:assert/strict";
import sharp from "sharp";
import { readBlockBuffer } from "../../../media-store.js";

/**
 * Create a tiny test image content block with sharp.
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number }} [color]
 * @returns {Promise<ImageContentBlock>}
 */
async function makeTestImage(width = 100, height = 100, color = { r: 255, g: 0, b: 0 }) {
  const buf = await sharp({
    create: { width, height, channels: 3, background: color },
  }).jpeg().toBuffer();
  return /** @type {ImageContentBlock} */ ({ type: "image", encoding: "base64", mime_type: "image/jpeg", data: buf.toString("base64") });
}

/** @type {ActionTestFn[]} */
export default [
  async function returns_error_when_no_image(action_fn) {
    const result = await action_fn(
      { content: [], log: async () => "" },
      { image: null, x: 0, y: 0, width: 50, height: 50 },
    );
    assert.ok(typeof result === "string");
    assert.ok(result.toLowerCase().includes("no image"));
  },

  async function returns_error_for_negative_coordinates(action_fn) {
    const image = await makeTestImage();
    const result = await action_fn(
      { content: [], log: async () => "" },
      { image, x: -10, y: 0, width: 50, height: 50 },
    );
    assert.ok(typeof result === "string");
    assert.ok(result.toLowerCase().includes("invalid"));
  },

  async function returns_error_for_zero_dimensions(action_fn) {
    const image = await makeTestImage();
    const result = await action_fn(
      { content: [], log: async () => "" },
      { image, x: 0, y: 0, width: 0, height: 50 },
    );
    assert.ok(typeof result === "string");
    assert.ok(result.toLowerCase().includes("invalid"));
  },

  async function returns_error_for_region_exceeding_bounds(action_fn) {
    const image = await makeTestImage();
    const result = await action_fn(
      { content: [], log: async () => "" },
      { image, x: 60, y: 0, width: 50, height: 100 },
    );
    assert.ok(typeof result === "string");
    assert.ok(result.toLowerCase().includes("exceed") || result.toLowerCase().includes("beyond") || result.toLowerCase().includes("outside"));
  },

  async function crops_image_and_returns_content_blocks(action_fn) {
    const image = await makeTestImage(100, 200);
    const result = await action_fn(
      { content: [], log: async () => "" },
      { image, x: 0, y: 0, width: 50, height: 50 },
    );

    assert.ok(typeof result === "object" && result !== null && "result" in result, "should return { result: ... }");
    const blocks = /** @type {{ result: ToolContentBlock[] }} */ (result).result;
    assert.ok(Array.isArray(blocks));

    const imageBlock = blocks.find((/** @type {ToolContentBlock} */ b) => b.type === "image");
    assert.ok(imageBlock, "should contain an image block");
    assert.equal(/** @type {ImageContentBlock} */ (imageBlock).mime_type, "image/jpeg");

    // Verify cropped dimensions: 50% of 100x200 = 50x100
    const cropped = await sharp(await readBlockBuffer(/** @type {ImageContentBlock} */ (imageBlock))).metadata();
    assert.equal(cropped.width, 50);
    assert.equal(cropped.height, 100);
  },

  async function clamps_rounding_at_edges(action_fn) {
    // 99x99 image, crop bottom-right 50% — percentages won't land on exact pixels
    const image = await makeTestImage(99, 99);
    const result = await action_fn(
      { content: [], log: async () => "" },
      { image, x: 50, y: 50, width: 50, height: 50 },
    );

    assert.ok(typeof result === "object" && result !== null && "result" in result);
    const blocks = /** @type {{ result: ToolContentBlock[] }} */ (result).result;
    const imageBlock = blocks.find((/** @type {ToolContentBlock} */ b) => b.type === "image");
    assert.ok(imageBlock, "should handle odd-sized images without crashing");
  },
];
