import config from "../../../config.js";
import { blockToDataUrl, writeMedia } from "../../../media-store.js";
import { resolveModel } from "../../../model-roles.js";

/**
 * Parse a data URL into its mime type and raw Buffer.
 * @param {string} dataUrl - e.g. "data:image/png;base64,iVBOR..."
 * @returns {{ mime_type: string, buffer: Buffer }}
 */
function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL");
  return { mime_type: match[1], buffer: Buffer.from(match[2], "base64") };
}

/**
 * Build the user message parts from prompt text and optional input images.
 * @param {string} prompt
 * @param {ImageContentBlock[]} images
 * @returns {Promise<Array<{type: string, text?: string, image_url?: {url: string}}>>}
 */
async function buildUserParts(prompt, images) {
  /** @type {Array<{type: string, text?: string, image_url?: {url: string}}>} */
  const parts = [{ type: "text", text: prompt }];

  for (const image of images) {
    parts.push({
      type: "image_url",
      image_url: { url: await blockToDataUrl(image) },
    });
  }

  return parts;
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "generate_image",
  command: "imagine",
  description:
    "Generate or edit images using AI. Provide a text prompt to generate an image, or include an image in the message to edit it.",
  sharedSkill: {
    name: "generate-image",
    description: "Generate a new image or edit an existing one and return it to the chat.",
    instructions: `Use this skill when the user needs a generated image artifact.
- Provide a clear prompt describing the desired output.
- Include source images when the user wants an edit rather than a fresh image.
- The generated result should be returned as an image attachment to the chat.`,
  },
  parameters: {
    type: "object",
    properties: {
      images: {
        type: "array",
        items: { type: "image" },
        description: "Optional input images for editing",
      },
      prompt: {
        type: "string",
        description: "Text description of the image to generate, or editing instructions if an input image is provided",
      },
    },
    required: ["prompt"],
  },
  formatToolCall: ({ prompt }) => {
    const maxLen = 60;
    const label = "Generating image";
    if (!prompt) return label;
    const short = prompt.length > maxLen ? prompt.slice(0, maxLen) + "…" : prompt;
    return `${label}: "${short}"`;
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /**
   * @param {ActionContext} _context
   * @param {{ images?: ImageContentBlock[], prompt: string }} params
   */
  action_fn: async function (_context, params) {
    const apiKey = config.llm_api_key;
    const baseUrl = config.base_url;
    if (!apiKey || !baseUrl) {
      return "Error: LLM_API_KEY and BASE_URL must be configured.";
    }

    const userParts = await buildUserParts(params.prompt, /** @type {ImageContentBlock[]} */ (params.images ?? []));

    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolveModel("image_generation"),
        messages: [{ role: "user", content: userParts }],
        modalities: ["image", "text"],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return `Error: Image API returned status ${response.status}: ${errorText}`;
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    if (!message) {
      return "Error: No response from image model.";
    }

    // Normalize response: content can be a string or an array of parts,
    // and images may appear in both message.content and message.images.
    let textContent = "";
    /** @type {Set<string>} */
    const imageUrls = new Set();

    if (typeof message.content === "string") {
      textContent = message.content;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") {
          textContent += part.text;
        } else if (part.type === "image_url") {
          imageUrls.add(part.image_url.url);
        }
      }
    }

    for (const img of message.images ?? []) {
      imageUrls.add(img.image_url.url);
    }

    if (imageUrls.size === 0) {
      return textContent || "The model did not generate any images.";
    }

    /** @type {ToolContentBlock[]} */
    const contentBlocks = [];

    const summary = `Generated ${imageUrls.size} image${imageUrls.size > 1 ? "s" : ""}.`;
    contentBlocks.push({ type: "text", text: textContent || summary });

    for (const dataUrl of imageUrls) {
      const { mime_type, buffer } = parseDataUrl(dataUrl);
      contentBlocks.push({
        type: "image",
        path: await writeMedia(buffer, mime_type, "image"),
        mime_type,
      });
    }

    return { result: contentBlocks };
  },
});
