import assert from "node:assert/strict";

/** @type {ActionTestFn[]} */
export default [
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
        const signal = /** @type {ActionSignal} */ (/** @type {ActionResult} */ (result));
        assert.equal(signal.autoContinue, false);
        assert.ok(Array.isArray(signal.result));
        const blocks = /** @type {ToolContentBlock[]} */ (signal.result);
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
        const blocks = /** @type {ToolContentBlock[]} */ (/** @type {ActionSignal} */ (/** @type {ActionResult} */ (result)).result);
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
];
