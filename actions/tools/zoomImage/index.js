import sharp from "sharp";

export default /** @type {defineAction} */ ((x) => x)({
  name: "zoom_image",
  description:
    "Crop a region of an image to zoom in on details like small text in receipts or documents. Uses percentage-based coordinates (0-100).",
  parameters: {
    type: "object",
    properties: {
      image: {
        type: "image",
        description: "The image to zoom into",
      },
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
    required: ["image", "x", "y", "width", "height"],
  },
  formatToolCall: ({ x, y, width, height }) =>
    `Zooming: region (${x}%, ${y}%) ${width}%×${height}%`,
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /**
   * @param {ActionContext} _context
   * @param {{ image: ImageContentBlock | null, x: number, y: number, width: number, height: number }} params
   */
  action_fn: async function (_context, params) {
    const { image, x, y, width, height } = params;

    if (!image || typeof image === "string") {
      const detail = typeof image === "string"
        ? `Received "${image}" which did not resolve to an image.`
        : "No image reference was provided.";
      return `${detail} Pass a [media:N] reference from the conversation.`;
    }

    // Validate ranges (negative or out-of-bounds)
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
      return `Invalid crop coordinates: x=${x}, y=${y}, width=${width}, height=${height}. All values must be non-negative and width/height must be positive.`;
    }
    if (x + width > 100 || y + height > 100) {
      return `Crop region exceeds image bounds: (${x}+${width}=${x + width}%, ${y}+${height}=${y + height}%). All coordinates must stay within 0-100%.`;
    }

    const inputBuffer = Buffer.from(image.data, "base64");
    const pipeline = sharp(inputBuffer);
    const metadata = await pipeline.metadata();
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

    const croppedBuffer = await pipeline
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
