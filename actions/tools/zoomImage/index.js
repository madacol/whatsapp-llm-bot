import sharp from "sharp";

/**
 * Find the last image in content blocks, including inside quotes.
 * Searches from the end so that _media_refs (appended last) take priority
 * over images already present in the user's message.
 * @param {IncomingContentBlock[]} content
 * @returns {ImageContentBlock | undefined}
 */
function findImage(content) {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "image") return block;
    if (block.type === "quote") {
      const inner = block.content.find(
        /** @returns {b is ImageContentBlock} */ (b) => b.type === "image",
      );
      if (inner) return inner;
    }
  }
  return undefined;
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "zoom_image",
  description:
    "Crop a region of an image to zoom in on details like small text in receipts or documents. Uses percentage-based coordinates (0-100).",
  parameters: {
    type: "object",
    properties: {
      x: {
        type: "number",
        description: "Left edge of crop region, as percentage of image width (0-100)",
      },
      y: {
        type: "number",
        description: "Top edge of crop region, as percentage of image height (0-100)",
      },
      width: {
        type: "number",
        description: "Width of crop region, as percentage of image width (0-100)",
      },
      height: {
        type: "number",
        description: "Height of crop region, as percentage of image height (0-100)",
      },
    },
    required: ["x", "y", "width", "height"],
  },
  formatToolCall: ({ x, y, width, height }) =>
    `Zooming: region (${x}%, ${y}%) ${width}%×${height}%`,
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /**
   * @param {ActionContext} context
   * @param {{ x: number, y: number, width: number, height: number }} params
   */
  action_fn: async function (context, params) {
    const { x, y, width, height } = params;

    // Validate ranges
    if (x + width > 100 || y + height > 100) {
      return `Crop region exceeds image bounds: (${x}+${width}=${x + width}%, ${y}+${height}=${y + height}%). All coordinates must stay within 0-100%.`;
    }

    const image = findImage(context.content);
    if (!image) {
      return "No image found. Please reference an image using [media:N] so I can zoom into it.";
    }

    const inputBuffer = Buffer.from(image.data, "base64");
    const metadata = await sharp(inputBuffer).metadata();
    const imgWidth = metadata.width ?? 0;
    const imgHeight = metadata.height ?? 0;

    if (imgWidth === 0 || imgHeight === 0) {
      return "Could not read image dimensions.";
    }

    // Convert percentages to pixels, clamping to image bounds
    const left = Math.round(imgWidth * x / 100);
    const top = Math.round(imgHeight * y / 100);
    const cropWidth = Math.min(Math.round(imgWidth * width / 100), imgWidth - left);
    const cropHeight = Math.min(Math.round(imgHeight * height / 100), imgHeight - top);

    if (cropWidth <= 0 || cropHeight <= 0) {
      return "Crop region is too small — results in zero-size image.";
    }

    const croppedBuffer = await sharp(inputBuffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .jpeg({ quality: 90 })
      .toBuffer();

    /** @type {ToolContentBlock[]} */
    const result = [
      { type: "text", text: `Cropped region: (${x}%, ${y}%) ${width}%×${height}% → ${cropWidth}×${cropHeight}px` },
      { type: "image", encoding: "base64", mime_type: "image/jpeg", data: croppedBuffer.toString("base64") },
    ];

    return { result };
  },
});
