import assert from "node:assert/strict";
import config from "../../config.js";

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
 * @param {IncomingContentBlock[]} content
 * @returns {Array<{type: string, text?: string, image_url?: {url: string}}>}
 */
function buildUserParts(prompt, content) {
  /** @type {Array<{type: string, text?: string, image_url?: {url: string}}>} */
  const parts = [{ type: "text", text: prompt }];

  for (const block of content) {
    if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.mime_type};base64,${block.data}` },
      });
    } else if (block.type === "quote") {
      for (const inner of block.content) {
        if (inner.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${inner.mime_type};base64,${inner.data}` },
          });
        }
      }
    }
  }

  return parts;
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "generate_image",
  command: "imagine",
  description:
    "Generate or edit images using AI. Provide a text prompt to generate an image, or include an image in the message to edit it.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate, or editing instructions if an input image is provided",
      },
    },
    required: ["prompt"],
  },
  permissions: {
    autoExecute: true,
    autoContinue: false,
  },
  test_functions: [
    async function test_generates_image_from_prompt(action_fn) {
      const originalFetch = globalThis.fetch;
      /** @type {Array<{image: Buffer, caption?: string}>} */
      const sentImages = [];
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "A beautiful sunset",
                images: [{
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
                }],
              },
            }],
          }),
        })));

        const result = await action_fn(
          {
            content: [{ type: "text", text: "a sunset" }],
            sendImage: async (/** @type {Buffer} */ image, /** @type {string | undefined} */ caption) => {
              sentImages.push({ image, caption });
            },
            log: async () => "",
          },
          { prompt: "a sunset" },
        );

        assert.equal(sentImages.length, 1);
        assert.ok(Buffer.isBuffer(sentImages[0].image));
        assert.equal(sentImages[0].caption, "A beautiful sunset");
        // Returns ActionSignal with content blocks
        assert.equal(result.autoContinue, false);
        assert.ok(Array.isArray(result.result));
        const blocks = /** @type {ToolContentBlock[]} */ (result.result);
        assert.ok(blocks.some((b) => b.type === "text"));
        assert.ok(blocks.some((b) => b.type === "image"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_passes_input_images_for_editing(action_fn) {
      const originalFetch = globalThis.fetch;
      /** @type {unknown} */
      let capturedBody;
      /** @type {Array<{image: Buffer, caption?: string}>} */
      const sentImages = [];
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
          capturedBody = JSON.parse(/** @type {string} */ (init.body));
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: "assistant",
                  content: "Edited image",
                  images: [{
                    type: "image_url",
                    image_url: { url: "data:image/png;base64,AAAA" },
                  }],
                },
              }],
            }),
          };
        }));

        await action_fn(
          {
            content: [
              { type: "text", text: "make it blue" },
              { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "abc123" },
            ],
            sendImage: async (/** @type {Buffer} */ image, /** @type {string | undefined} */ caption) => {
              sentImages.push({ image, caption });
            },
            log: async () => "",
          },
          { prompt: "make it blue" },
        );

        // Check that the input image was included in the request
        const body = /** @type {{messages: Array<{content: Array<{type: string, image_url?: {url: string}}>}>}} */ (capturedBody);
        const userContent = body.messages[0].content;
        const imagepart = userContent.find((/** @type {{type: string}} */ p) => p.type === "image_url");
        assert.ok(imagepart, "Request should include input image");
        assert.ok(sentImages.length === 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_passes_quoted_images_for_editing(action_fn) {
      const originalFetch = globalThis.fetch;
      /** @type {unknown} */
      let capturedBody;
      /** @type {Array<{image: Buffer, caption?: string}>} */
      const sentImages = [];
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
          capturedBody = JSON.parse(/** @type {string} */ (init.body));
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  role: "assistant",
                  content: "Edited image",
                  images: [{
                    type: "image_url",
                    image_url: { url: "data:image/png;base64,AAAA" },
                  }],
                },
              }],
            }),
          };
        }));

        await action_fn(
          {
            content: [
              { type: "text", text: "make it blue" },
              { type: "quote", content: [
                { type: "image", encoding: "base64", mime_type: "image/jpeg", data: "quoted-img-data" },
              ]},
            ],
            sendImage: async (/** @type {Buffer} */ image, /** @type {string | undefined} */ caption) => {
              sentImages.push({ image, caption });
            },
            log: async () => "",
          },
          { prompt: "make it blue" },
        );

        const body = /** @type {{messages: Array<{content: Array<{type: string, image_url?: {url: string}}>}>}} */ (capturedBody);
        const userContent = body.messages[0].content;
        const imagePart = userContent.find((/** @type {{type: string}} */ p) => p.type === "image_url");
        assert.ok(imagePart, "Request should include quoted image");
        assert.ok(/** @type {{image_url: {url: string}}} */ (imagePart).image_url.url.includes("quoted-img-data"));
        assert.ok(sentImages.length === 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_deduplicates_images_from_content_array_and_images_field(action_fn) {
      const originalFetch = globalThis.fetch;
      /** @type {Array<{image: Buffer, caption?: string}>} */
      const sentImages = [];
      const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
      try {
        // Simulate API returning the same image in both content array and images field
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "Here is the image" },
                  { type: "image_url", image_url: { url: imageDataUrl } },
                ],
                images: [
                  { type: "image_url", image_url: { url: imageDataUrl } },
                ],
              },
            }],
          }),
        })));

        const result = await action_fn(
          {
            content: [{ type: "text", text: "a cat" }],
            sendImage: async (/** @type {Buffer} */ image, /** @type {string | undefined} */ caption) => {
              sentImages.push({ image, caption });
            },
            log: async () => "",
          },
          { prompt: "a cat" },
        );

        assert.equal(sentImages.length, 1, "Should send exactly 1 image, not duplicates");
        const blocks = /** @type {ToolContentBlock[]} */ (result.result);
        const imageBlocks = blocks.filter((b) => b.type === "image");
        assert.equal(imageBlocks.length, 1, "Should have exactly 1 image content block");
        assert.ok(blocks.some((b) => b.type === "text" && /** @type {TextContentBlock} */ (b).text === "Here is the image"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_handles_api_error(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })));

        const result = await action_fn(
          {
            content: [{ type: "text", text: "test" }],
            sendImage: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.includes("500"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async function test_handles_response_with_no_images(action_fn) {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "I cannot generate that image",
              },
            }],
          }),
        })));

        const result = await action_fn(
          {
            content: [{ type: "text", text: "test" }],
            sendImage: async () => {},
            log: async () => "",
          },
          { prompt: "test" },
        );

        assert.ok(typeof result === "string");
        assert.ok(result.includes("I cannot generate that image"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  ],
  /**
   * @param {ActionContext} context
   * @param {{ prompt: string }} params
   */
  action_fn: async function (context, params) {
    const apiKey = config.llm_api_key;
    const baseUrl = config.base_url;
    if (!apiKey || !baseUrl) {
      return "Error: LLM_API_KEY and BASE_URL must be configured.";
    }

    await context.log(`Generating image: ${params.prompt}`);

    const userParts = buildUserParts(params.prompt, context.content);

    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.image_model,
        messages: [{ role: "user", content: userParts }],
        modalities: ["image", "text"],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return `Error: Image API returned status ${response.status}: ${errorText}`;
    }

    const data = await response.json();
    await context.log("Image API response: " + JSON.stringify(data).slice(0, 500));
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
      const base64 = buffer.toString("base64");
      contentBlocks.push({
        type: "image",
        encoding: "base64",
        mime_type,
        data: base64,
      });
      await context.sendImage(buffer, textContent || undefined);
    }

    return /** @type {ActionSignal} */ ({
      result: contentBlocks,
      autoContinue: false,
    });
  },
});
